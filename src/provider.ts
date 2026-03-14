import { CancellationToken, LanguageModelChatMessageRole, LanguageModelChatToolMode, LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, Progress, workspace, ConfigurationChangeEvent, EventEmitter, window, OutputChannel, env } from "vscode";
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

/** Shape returned by the LM Studio native /api/v1/models endpoint. */
interface LMStudioNativeModelInstance {
	id: string;
	config: {
		context_length: number;
		eval_batch_size?: number;
		flash_attention?: boolean;
		num_experts?: number;
		offload_kv_cache_to_gpu?: boolean;
	};
}

interface LMStudioNativeModel {
	type: 'llm' | 'embedding';
	publisher: string;
	key: string;
	display_name: string;
	architecture?: string | null;
	max_context_length: number;
	loaded_instances: LMStudioNativeModelInstance[];
	capabilities?: {
		vision: boolean;
		trained_for_tool_use: boolean;
	};
}

interface LMStudioNativeModelsResponse {
	models: LMStudioNativeModel[];
}

/** A single SSE delta from /v1/chat/completions (streaming). */
interface ChatCompletionToolCallDelta {
	index: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

interface ChatCompletionChunkChoice {
	delta: { role?: string; content?: string | null; tool_calls?: ChatCompletionToolCallDelta[] };
	finish_reason: string | null;
}

interface ChatCompletionChunk {
	choices: ChatCompletionChunkChoice[];
}

function getChatModelInfo(id: string, name: string, maxInputTokens: number, maxOutputTokens: number, supportsTools = true, imageInput = false): LanguageModelChatInformation {
	return {
		id,
		name,
		family: "lmstudio",
		maxInputTokens,
		maxOutputTokens,
		version: "1.0.0",
		capabilities: {
			toolCalling: supportsTools,
			imageInput,
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

	/**
	 * When running inside a dev container or remote environment, rewrite
	 * localhost / 127.0.0.1 to host.docker.internal so the extension can
	 * reach the LM Studio server on the host machine.
	 */
	private resolveHostUrl(url: string): string {
		const remoteName = env.remoteName;
		if (!remoteName || remoteName === 'wsl') {
			return url;
		}
		const rewritten = url.replace(
			/\/\/(localhost|127\.0\.0\.1)\b/,
			'//host.docker.internal',
		);
		if (rewritten !== url) {
			this.log(
				`Remote environment detected (${remoteName}). ` +
				`Rewrote base URL to ${rewritten} so it can reach the host machine. ` +
				`Override this by setting lmstudio.baseUrl to a non-localhost address.`,
			);
		}
		return rewritten;
	}

	private getBaseUrl(): string {
		const config = workspace.getConfiguration('lmstudio');
		const configUrl = config.get<string>('baseUrl');
		if (configUrl) {
			this.log('Using base URL from VS Code settings');
			return this.resolveHostUrl(configUrl.replace(/\/+$/, '')); // strip trailing slashes
		}
		this.log('Using default base URL');
		return this.resolveHostUrl('http://localhost:1234');
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

	/**
	 * Try to fetch models from the native LM Studio REST API (`/api/v1/models`),
	 * which includes the actually configured context length per loaded instance.
	 * Returns null if the endpoint is unavailable (older LM Studio versions).
	 */
	private async fetchNativeModels(baseUrl: string): Promise<LMStudioNativeModelsResponse | null> {
		try {
			this.log(`Trying native API: ${baseUrl}/api/v1/models ...`);
			const resp = await fetch(`${baseUrl}/api/v1/models`, { headers: this.buildHeaders() });
			if (!resp.ok) {
				this.log(`Native API returned HTTP ${resp.status}, falling back to OpenAI-compat endpoint`);
				return null;
			}
			return (await resp.json()) as LMStudioNativeModelsResponse;
		} catch (err) {
			this.log(`Native API unavailable: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	async provideLanguageModelChatInformation(_options: PrepareLanguageModelChatModelOptions, _token: CancellationToken): Promise<LanguageModelChatInformation[]> {
		const now = Date.now();
		if (this.cachedModels && (now - this.cacheTimestamp) < this.CACHE_DURATION) {
			this.log('Using cached models');
			return this.cachedModels;
		}

		const baseUrl = this.getBaseUrl();

		try {
			// Try the native REST API first — it exposes the actual configured context length
			const nativeResponse = await this.fetchNativeModels(baseUrl);
			if (nativeResponse) {
				const models: LanguageModelChatInformation[] = [];
				for (const m of nativeResponse.models) {
					if (m.type !== 'llm') { continue; }
					for (const instance of m.loaded_instances) {
						const contextLength = instance.config.context_length;
						const maxOutput = Math.min(8192, contextLength);
						const supportsTools = m.capabilities?.trained_for_tool_use ?? true;
						const supportsVision = m.capabilities?.vision ?? false;
						this.log(`Adding model ${instance.id} (configured context: ${contextLength}, maxOutput: ${maxOutput}, tools: ${supportsTools}, vision: ${supportsVision})`);
						models.push(getChatModelInfo(instance.id, instance.id, contextLength, maxOutput, supportsTools, supportsVision));
					}
				}

				if (models.length > 0) {
					this.log(`Native API: found ${models.length} loaded model(s)`);
					this.cachedModels = models;
					this.cacheTimestamp = now;
					return models;
				}

				this.log('Native API: no loaded LLM instances found');
				return [
					getChatModelInfo("no-models-loaded", "📱 Load a Model in LM Studio", 32768, 8192, false),
				];
			}

			// Fallback: OpenAI-compat /v1/models (older LM Studio versions)
			this.log(`Fetching models from ${baseUrl}/v1/models ...`);
			const resp = await fetch(`${baseUrl}/v1/models`, { headers: this.buildHeaders() });

			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`HTTP ${resp.status}: ${body}`);
			}

			const json = (await resp.json()) as LMStudioModelsResponse;
			this.log(`Successfully connected! Found ${json.data.length} models (context length unavailable — using defaults)`);

			const models: LanguageModelChatInformation[] = json.data.map(m => {
				this.log(`Adding model ${m.id} (default context: 32768)`);
				return getChatModelInfo(m.id, m.id, 32768, 8192, true);
			});

			if (models.length > 0) {
				this.cachedModels = models;
				this.cacheTimestamp = now;
				return models;
			}

			this.log('No models are currently loaded in LM Studio');
			return [
				getChatModelInfo("no-models-loaded", "📱 Load a Model in LM Studio", 32768, 8192, false),
			];

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

			return [
				getChatModelInfo("connection-error", errorModelName, 32768, 8192, false),
			];
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
			const chatMessages: Array<Record<string, unknown>> = [];
			messages.forEach((msg, index) => {
				const role = msg.role === LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';

				// Collect text parts, tool call parts (assistant), and tool result parts (user) separately
				const textParts: string[] = [];
				const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
				const toolResults: Array<{ callId: string; content: string }> = [];

				for (const part of msg.content) {
					if (part instanceof LanguageModelTextPart) {
						textParts.push(part.value);
					} else if (part instanceof LanguageModelToolCallPart) {
						toolCalls.push({
							id: part.callId,
							type: 'function',
							function: { name: part.name, arguments: JSON.stringify(part.input) },
						});
					} else if (part instanceof LanguageModelToolResultPart) {
						const resultText = part.content
							.map(c => c instanceof LanguageModelTextPart ? c.value : JSON.stringify(c))
							.join('');
						toolResults.push({ callId: part.callId, content: resultText });
					}
				}

				// Emit assistant message with tool_calls if present
				if (role === 'assistant' && toolCalls.length > 0) {
					const text = textParts.join('') || null;
					this.log(`Message ${index}: role=assistant (tool_calls=${toolCalls.length}) content=${text ? text.substring(0, 80) : 'null'}`);
					chatMessages.push({ role: 'assistant', content: text, tool_calls: toolCalls });
				}
				// Emit tool result messages
				else if (toolResults.length > 0) {
					// If the message also has text, emit a user message for the text first
					const text = textParts.join('');
					if (text) {
						chatMessages.push({ role: 'user', content: text });
					}
					for (const tr of toolResults) {
						this.log(`Message ${index}: role=tool tool_call_id=${tr.callId} content=${tr.content.substring(0, 80)}`);
						chatMessages.push({ role: 'tool', tool_call_id: tr.callId, content: tr.content });
					}
				}
				// Normal text message
				else {
					const text = textParts.join('');
					this.log(`Message ${index}: role=${msg.role}->${role} content=${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);
					chatMessages.push({ role, content: text });
				}
			});

			const requestBody: Record<string, unknown> = {
				model: model.id,
				messages: chatMessages,
				stream: true,
				max_tokens: options.modelOptions?.maxTokens || 8192,
			};

			// Pass tools to model if provided
			if (options.tools && options.tools.length > 0) {
				requestBody.tools = options.tools.map(t => {
					// Ensure parameters is a valid JSON Schema object with "type": "object"
					let parameters: Record<string, unknown> = { type: 'object', properties: {} };
					if (t.inputSchema && typeof t.inputSchema === 'object') {
						const schema = t.inputSchema as Record<string, unknown>;
						if (schema.type === 'object') {
							parameters = schema;
						} else {
							// Wrap non-object schemas to satisfy LM Studio's requirement
							parameters = { ...schema, type: 'object' };
							if (!parameters.properties) {
								parameters.properties = {};
							}
						}
					}
					return {
						type: 'function' as const,
						function: {
							name: t.name,
							description: t.description,
							parameters,
						},
					};
				});
				if (options.toolMode === LanguageModelChatToolMode.Required) {
					requestBody.tool_choice = 'required';
				} else {
					requestBody.tool_choice = 'auto';
				}
				this.log(`Including ${options.tools.length} tools, tool_choice=${requestBody.tool_choice}`);
			}

			const body = JSON.stringify(requestBody);

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

				// Accumulate streamed tool call fragments by index
				const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

				// Regex to detect tool calls emitted as plain text by models that don't
				// use the structured tool_calls delta (e.g. "functionName[ARGS]{...json...}")
				const TEXT_TOOL_CALL_RE = /([a-zA-Z_][\w]*)\[ARGS\](\{[\s\S]*\})\s*$/;
				let textToolCallBuffer = '';
				let textToolCallCallId = 0;

				const flushContent = () => {
					if (accumulatedContent.length > 0) {
						// Check if accumulated content contains a text-based tool call
						const combined = textToolCallBuffer + accumulatedContent;
						const match = TEXT_TOOL_CALL_RE.exec(combined);
						if (match) {
							// Report any text *before* the tool call pattern
							const beforeToolCall = combined.substring(0, match.index).trimEnd();
							if (beforeToolCall.length > 0) {
								this.log(`Flushing text before text-tool-call: "${beforeToolCall.substring(0, 50)}"`);
								try {
									progress.report(new LanguageModelTextPart(beforeToolCall));
									receivedChars += beforeToolCall.length;
									index++;
								} catch (error) {
									this.logError('Error reporting fragment', error);
								}
							}
							// Emit the tool call as a proper LanguageModelToolCallPart
							const toolName = match[1];
							const toolArgsRaw = match[2];
							let toolInput: object;
							try {
								toolInput = JSON.parse(toolArgsRaw) as object;
							} catch {
								toolInput = {};
							}
							const callId = `text_call_${textToolCallCallId++}`;
							this.log(`Detected text-based tool call: name=${toolName} callId=${callId} args=${toolArgsRaw.substring(0, 80)}`);
							progress.report(new LanguageModelToolCallPart(callId, toolName, toolInput));
							accumulatedContent = '';
							textToolCallBuffer = '';
							return;
						}

						// Check if content might be the start of a text tool call (partial match)
						// e.g. we have "create_new_workspace[AR" — don't flush yet, keep buffering
						const partialIdx = combined.search(/[a-zA-Z_][\w]*\[A[R]?[G]?[S]?$/);
						if (partialIdx >= 0) {
							// Flush the safe portion before the potential partial match
							const safe = combined.substring(0, partialIdx);
							if (safe.length > 0) {
								this.log(`Flushing batch ${index}: "${safe.substring(0, 50)}${safe.length > 50 ? '...' : ''}"`);
								try {
									progress.report(new LanguageModelTextPart(safe));
									receivedChars += safe.length;
									index++;
								} catch (error) {
									this.logError('Error reporting fragment', error);
								}
							}
							textToolCallBuffer = combined.substring(partialIdx);
							accumulatedContent = '';
							return;
						}

						const toFlush = combined;
						textToolCallBuffer = '';
						this.log(`Flushing batch ${index}: "${toFlush.substring(0, 50)}${toFlush.length > 50 ? '...' : ''}"`);
						try {
							progress.report(new LanguageModelTextPart(toFlush));
							receivedChars += toFlush.length;
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

						const choice = chunk.choices?.[0];
						if (!choice) { continue; }

						// Accumulate tool call deltas
						if (choice.delta?.tool_calls) {
							for (const tc of choice.delta.tool_calls) {
								const existing = pendingToolCalls.get(tc.index);
								if (existing) {
									if (tc.function?.arguments) {
										existing.arguments += tc.function.arguments;
									}
								} else {
									pendingToolCalls.set(tc.index, {
										id: tc.id || `call_${tc.index}`,
										name: tc.function?.name || '',
										arguments: tc.function?.arguments || '',
									});
								}
							}
						}

						// Emit tool calls when finish_reason indicates tool_calls
						if (choice.finish_reason === 'tool_calls' && pendingToolCalls.size > 0) {
							flushContent();
							for (const [, tc] of pendingToolCalls) {
								let input: object;
								try {
									input = JSON.parse(tc.arguments) as object;
								} catch {
									input = {};
								}
								this.log(`Emitting tool call: id=${tc.id} name=${tc.name} args=${tc.arguments.substring(0, 80)}`);
								progress.report(new LanguageModelToolCallPart(tc.id, tc.name, input));
							}
							pendingToolCalls.clear();
						}

						const content = choice.delta?.content;
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

				// Flush the TextDecoder and process any remaining data in the buffer
				buffer += decoder.decode();
				if (buffer.trim()) {
					const remaining = buffer.trim();
					if (remaining.startsWith('data: ') && remaining.slice(6) !== '[DONE]') {
						try {
							const chunk: ChatCompletionChunk = JSON.parse(remaining.slice(6));
							const content = chunk.choices?.[0]?.delta?.content;
							if (content && !skipThinkMode) {
								accumulatedContent += content;
							}
							// Handle any final tool call deltas in the remaining buffer
							const choice = chunk.choices?.[0];
							if (choice?.delta?.tool_calls) {
								for (const tc of choice.delta.tool_calls) {
									const existing = pendingToolCalls.get(tc.index);
									if (existing) {
										if (tc.function?.arguments) { existing.arguments += tc.function.arguments; }
									} else {
										pendingToolCalls.set(tc.index, {
											id: tc.id || `call_${tc.index}`,
											name: tc.function?.name || '',
											arguments: tc.function?.arguments || '',
										});
									}
								}
							}
							if (choice.finish_reason === 'tool_calls') {
								for (const [, tc] of pendingToolCalls) {
									let input: object;
									try { input = JSON.parse(tc.arguments) as object; } catch { input = {}; }
									this.log(`Emitting tool call (remaining buffer): id=${tc.id} name=${tc.name}`);
									progress.report(new LanguageModelToolCallPart(tc.id, tc.name, input));
								}
								pendingToolCalls.clear();
							}
						} catch {
							this.log(`Skipping unparseable remaining buffer: ${remaining.substring(0, 80)}`);
						}
					}
				}

				// Emit any pending tool calls that weren't flushed (e.g. if finish_reason was missed)
				if (pendingToolCalls.size > 0) {
					flushContent();
					for (const [, tc] of pendingToolCalls) {
						let input: object;
						try { input = JSON.parse(tc.arguments) as object; } catch { input = {}; }
						this.log(`Emitting tool call (stream end): id=${tc.id} name=${tc.name}`);
						progress.report(new LanguageModelToolCallPart(tc.id, tc.name, input));
					}
					pendingToolCalls.clear();
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