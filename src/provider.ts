import { CancellationToken, LanguageModelChatMessageRole, LanguageModelTextPart, LanguageModelToolCallPart, Progress, workspace, ConfigurationChangeEvent, EventEmitter, window, OutputChannel } from "vscode";
import { LanguageModelChatInformation, LanguageModelChatProvider, LanguageModelChatRequestMessage, LanguageModelResponsePart, ProvideLanguageModelChatResponseOptions, PrepareLanguageModelChatModelOptions } from "vscode";
import { encode } from 'gpt-tokenizer';

/** Shape returned by the LM Studio /v1/models endpoint. */
interface LMStudioModel {
	id: string;
	object: string;
	owned_by?: string;
}

interface LMStudioModelsResponse {
	data: LMStudioModel[];
}

/** A single SSE delta from /v1/chat/completions (streaming). */
interface ChatCompletionChunkChoice {
	delta: { role?: string; content?: string };
	finish_reason: string | null;
}

interface ChatCompletionChunk {
	choices: ChatCompletionChunkChoice[];
}

function getChatModelInfo(id: string, name: string, maxInputTokens: number, maxOutputTokens: number, supportsTools = true): LanguageModelChatInformation {
	return {
		id,
		name,
		family: "lmstudio",
		maxInputTokens,
		maxOutputTokens,
		version: "1.0.0",
		capabilities: {
			toolCalling: supportsTools,
			imageInput: false,
		}
	};
}

export class LMStudioChatModelProvider implements LanguageModelChatProvider {
	private _onDidChange = new EventEmitter<void>();
	private cachedModels: LanguageModelChatInformation[] | null = null;
	private cacheTimestamp = 0;
	private readonly CACHE_DURATION = 30000; // 30 seconds
	private output: OutputChannel;
	private verbose = false;

	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor() {
		this.output = window.createOutputChannel('LM Studio');
		this.loadVerbosity();
		workspace.onDidChangeConfiguration((e: ConfigurationChangeEvent) => {
			if (e.affectsConfiguration('lmstudio.baseUrl') || e.affectsConfiguration('lmstudio.apiKey') || e.affectsConfiguration('lmstudio.verboseLogging')) {
				this.log('Configuration changed, clearing cache');
				this.loadVerbosity();
				this.cachedModels = null;
				this.cacheTimestamp = 0;
				this._onDidChange.fire();
			}
		});
	}

	private loadVerbosity() {
		try {
			const config = workspace.getConfiguration('lmstudio');
			this.verbose = !!config.get<boolean>('verboseLogging');
		} catch {
			this.verbose = false;
		}
	}

	private log(msg: string) {
		if (this.verbose) {
			this.output.appendLine(`[${new Date().toISOString()}] ${msg}`);
		}
		console.log(`LM Studio: ${msg}`);
	}

	private logError(msg: string, err: unknown) {
		const detail = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
		if (this.verbose) {
			this.output.appendLine(`[${new Date().toISOString()}] ERROR ${msg}: ${detail}`);
		}
		console.error(`LM Studio: ${msg}`, err);
	}

	private getBaseUrl(): string {
		const config = workspace.getConfiguration('lmstudio');
		const configUrl = config.get<string>('baseUrl');
		if (configUrl) {
			this.log('Using base URL from VS Code settings');
			return configUrl.replace(/\/+$/, ''); // strip trailing slashes
		}
		this.log('Using default base URL');
		return 'http://localhost:1234';
	}

	private getApiKey(): string | null {
		const envKey = process.env.LMSTUDIO_API_KEY;
		if (envKey) {
			this.log('Using API key from environment variable');
			return envKey;
		}
		const config = workspace.getConfiguration('lmstudio');
		const configKey = config.get<string>('apiKey');
		if (configKey) {
			this.log('Using API key from VS Code settings');
			return configKey;
		}
		this.log('No API key found (this is OK for local instances)');
		return null;
	}

	/** Build common headers for LM Studio HTTP requests. */
	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		const apiKey = this.getApiKey();
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}
		return headers;
	}

	async provideLanguageModelChatInformation(_options: PrepareLanguageModelChatModelOptions, _token: CancellationToken): Promise<LanguageModelChatInformation[]> {
		const now = Date.now();
		if (this.cachedModels && (now - this.cacheTimestamp) < this.CACHE_DURATION) {
			this.log('Using cached models');
			return this.cachedModels;
		}

		const baseUrl = this.getBaseUrl();

		try {
			this.log(`Fetching models from ${baseUrl}/v1/models ...`);
			const resp = await fetch(`${baseUrl}/v1/models`, { headers: this.buildHeaders() });

			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`HTTP ${resp.status}: ${body}`);
			}

			const json = (await resp.json()) as LMStudioModelsResponse;
			this.log(`Successfully connected! Found ${json.data.length} models`);

			const models: LanguageModelChatInformation[] = json.data.map(m => {
				this.log(`Adding model ${m.id}`);
				return getChatModelInfo(m.id, m.id, 32768, 8192, true);
			});

			if (models.length > 0) {
				this.cachedModels = models;
				this.cacheTimestamp = now;
				return models;
			}

			this.log('No models are currently loaded in LM Studio');
			const fallbackModels = [
				getChatModelInfo("no-models-loaded", "📱 Load a Model in LM Studio", 32768, 8192, false),
			];
			this.cachedModels = fallbackModels;
			this.cacheTimestamp = now;
			return fallbackModels;

		} catch (error) {
			this.logError('Could not connect to LM Studio server', error);

			let errorModelName = "Connection Error - Check LM Studio";
			if (error instanceof Error) {
				this.logError('Connection error details', error);
				if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
					errorModelName = "🔌 Start LM Studio Server (Local Server tab)";
				} else if (error.message.includes('401') || error.message.includes('unauthorized')) {
					errorModelName = "🔐 Authentication Error (Check API key)";
				} else if (error.message.includes('timeout')) {
					errorModelName = "⏱️ Connection Timeout - Check Network";
				} else {
					errorModelName = `❌ ${error.message.substring(0, 50)}`;
				}
			}

			const fallbackModels = [
				getChatModelInfo("connection-error", errorModelName, 32768, 8192, false),
			];
			this.cachedModels = fallbackModels;
			this.cacheTimestamp = now;
			return fallbackModels;
		}
	}

	public refreshModels(): void {
		console.log('LM Studio: Manually refreshing model cache');
		this.cachedModels = null;
		this.cacheTimestamp = 0;
		this._onDidChange.fire();
	}

	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {
		const baseUrl = this.getBaseUrl();
		const started = Date.now();
		this.log(`Chat request started with model='${model.id}' messages=${messages.length} maxTokens=${options.modelOptions?.maxTokens}`);

		if (model.id === "no-models-loaded" || model.id === "connection-error" || model.id === "server-not-started") {
			progress.report(
				new LanguageModelTextPart(
					"🚨 **LM Studio Server Not Started or No Model Loaded**\n\n" +
					"**Quick Fix Steps:**\n" +
					"1. 🚀 Open LM Studio application\n" +
					"2. 🌐 Click the 'Local Server' tab at the top\n" +
					"3. ▶️ Click 'Start Server' button\n" +
					"4. 📱 Load a model (click 'Select a model' if none loaded)\n" +
					"5. 🔄 Try your chat request again\n\n" +
					`**Connecting to:** ${baseUrl}\n`
				)
			);
			return;
		}

		try {
			// Convert VS Code messages to OpenAI chat format
			const chatMessages = messages.map((msg, index) => {
				const content = msg.content
					.map(part => {
						if (part instanceof LanguageModelTextPart) {
							return part.value;
						} else if (part instanceof LanguageModelToolCallPart) {
							return `[Tool Call: ${part.name}(${JSON.stringify(part.input)})]`;
						}
						return '';
					})
					.join('');

				let role: 'user' | 'assistant' | 'system';
				switch (msg.role) {
					case LanguageModelChatMessageRole.User:
						role = 'user';
						break;
					case LanguageModelChatMessageRole.Assistant:
						role = 'assistant';
						break;
					default:
						role = 'user';
						break;
				}

				this.log(`Message ${index}: role=${msg.role}->${role} content=${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
				return { role, content };
			});

			const body = JSON.stringify({
				model: model.id,
				messages: chatMessages,
				stream: true,
				max_tokens: options.modelOptions?.maxTokens || 8192,
			});

			this.log(`POST ${baseUrl}/v1/chat/completions  model=${model.id}`);

			const controller = new AbortController();
			const onCancel = token.onCancellationRequested(() => {
				this.log('Cancellation requested, aborting fetch');
				controller.abort();
			});

			try {
				const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
					method: 'POST',
					headers: this.buildHeaders(),
					body,
					signal: controller.signal,
				});

				if (!resp.ok) {
					const errBody = await resp.text();
					throw new Error(`HTTP ${resp.status}: ${errBody}`);
				}

				if (!resp.body) {
					throw new Error('Response body is empty');
				}

				// Stream SSE chunks
				const reader = resp.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';
				let index = 0;
				let receivedChars = 0;
				let firstFragmentTime: number | undefined;
				let skipThinkMode = false;
				let accumulatedContent = '';
				let lastReportTime = Date.now();
				const BATCH_DELAY_MS = 100;
				let fragmentCount = 0;

				const flushContent = () => {
					if (accumulatedContent.trim().length > 0) {
						this.log(`Flushing batch ${index}: "${accumulatedContent.substring(0, 50)}${accumulatedContent.length > 50 ? '...' : ''}"`);
						try {
							progress.report(new LanguageModelTextPart(accumulatedContent));
							receivedChars += accumulatedContent.length;
							accumulatedContent = '';
							index++;
						} catch (error) {
							this.logError('Error reporting fragment', error);
						}
					}
				};

				while (true) {
					const { done, value } = await reader.read();
					if (done) { break; }

					buffer += decoder.decode(value, { stream: true });

					// Process complete SSE lines
					const lines = buffer.split('\n');
					buffer = lines.pop() || ''; // keep incomplete line in buffer

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
						const data = trimmed.slice(6);
						if (data === '[DONE]') { continue; }

						let chunk: ChatCompletionChunk;
						try {
							chunk = JSON.parse(data);
						} catch {
							this.log(`Skipping unparseable SSE chunk: ${data.substring(0, 80)}`);
							continue;
						}

						const content = chunk.choices?.[0]?.delta?.content;
						if (!content) { continue; }

						if (firstFragmentTime === undefined) {
							firstFragmentTime = Date.now();
							this.log(`First fragment received after ${firstFragmentTime - started}ms`);
						}

						fragmentCount++;

						// Handle thinking mode - skip <think> content entirely
						if (content === '<think>' || content === '<|channel|>analysis<|message|>') {
							skipThinkMode = true;
							this.log(`Fragment skipped (start thinking): raw="${content}"`);
							continue;
						} else if (content === '</think>' || content === '<|end|>') {
							skipThinkMode = false;
							this.log(`Fragment skipped (end thinking): raw="${content}"`);
							continue;
						} else if (skipThinkMode) {
							this.log(`Fragment skipped (thinking mode): raw="${content}"`);
							continue;
						}

						if (content === '<|channel|>final<|message|>' ||
							content === '<|start|>assistant' ||
							content === '<|end|>') {
							this.log(`Fragment skipped (empty token): raw="${content}"`);
							continue;
						}

						if (content.length > 0) {
							accumulatedContent += content;

							const now = Date.now();
							const shouldFlush =
								content.includes('\n\n') ||
								content.includes('```') ||
								accumulatedContent.length >= 50 ||
								(now - lastReportTime) >= BATCH_DELAY_MS ||
								(fragmentCount % 10 === 0);

							if (shouldFlush) {
								flushContent();
								lastReportTime = now;
							}
						}
					}
				}

				flushContent();
				const ended = Date.now();
				this.log(`Streaming complete fragments=${index} chars=${receivedChars} duration=${ended - started}ms firstFragmentLatency=${firstFragmentTime ? firstFragmentTime - started : 'n/a'}ms`);
			} finally {
				onCancel.dispose();
			}

		} catch (error) {
			if ((error as Error).name === 'AbortError') {
				this.log('Request aborted by user');
				return;
			}

			let errorMessage = 'Unknown error occurred';
			if (error instanceof Error) {
				errorMessage = error.message;

				if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
					errorMessage = "🔌 **Cannot connect to LM Studio**\n\n" +
						"**Troubleshooting steps:**\n" +
						"1. 🚀 Start LM Studio application\n" +
						"2. 🌐 Go to 'Local Server' tab\n" +
						"3. ▶️ Click 'Start Server'\n" +
						"4. 📱 Load a model (click 'Select a model')\n" +
						"5. 🔄 Try your request again\n\n" +
						`**Connecting to:** ${baseUrl}\n`;
				} else if (errorMessage.includes('401') || errorMessage.includes('unauthorized')) {
					errorMessage = "🔐 **Authentication failed**\n\nPlease check your LM Studio API key in VS Code settings.";
				} else if (errorMessage.includes('No models available') || errorMessage.includes('No models are currently loaded')) {
					errorMessage = "📱 **No models loaded in LM Studio**\n\nLoad a model in the Local Server tab and try again.";
				} else if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
					errorMessage = "⏱️ **Rate limit exceeded**\n\nPlease wait a moment and try again.";
				}
			}

			progress.report(new LanguageModelTextPart(errorMessage));
		}
	}

	async provideTokenCount(_model: LanguageModelChatInformation, text: string | LanguageModelChatRequestMessage, _token: CancellationToken): Promise<number> {
		try {
			let content: string;
			if (typeof text === 'string') {
				content = text;
			} else {
				content = text.content
					.map(part => part instanceof LanguageModelTextPart ? part.value : '')
					.join('');
			}

			const tokens = encode(content);
			return tokens.length;
		} catch {
			let content: string;
			if (typeof text === 'string') {
				content = text;
			} else {
				content = text.content
					.map(part => part instanceof LanguageModelTextPart ? part.value : '')
					.join('');
			}
			return Math.ceil(content.length / 4);
		}
	}
}