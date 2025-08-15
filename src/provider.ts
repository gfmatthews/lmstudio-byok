import { CancellationToken, LanguageModelChatMessage, LanguageModelChatMessageRole, LanguageModelTextPart, LanguageModelToolCallPart, Progress, workspace, ConfigurationChangeEvent, EventEmitter, window, OutputChannel } from "vscode";
import { ChatResponseFragment2, LanguageModelChatInformation, LanguageModelChatProvider2, LanguageModelChatRequestHandleOptions } from "vscode";
import { LMStudioClient } from '@lmstudio/sdk';
import { encode } from 'gpt-tokenizer';

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
			vision: false, // LM Studio models vary, but default to false for safety
		}
	};
}

export class LMStudioChatModelProvider implements LanguageModelChatProvider2 {
	private client: LMStudioClient | null = null;
	private lastBaseUrl: string | null = null;
	private lastApiKey: string | null = null;
	private _onDidChange = new EventEmitter<void>();
	private cachedModels: LanguageModelChatInformation[] | null = null;
	private cacheTimestamp = 0;
	private readonly CACHE_DURATION = 30000; // 30 seconds
	private output: OutputChannel;
	private verbose = false;

	readonly onDidChange = this._onDidChange.event;

	constructor() {
		this.output = window.createOutputChannel('LM Studio');
		this.loadVerbosity();
		// Listen for configuration changes to refresh the client
		workspace.onDidChangeConfiguration((e: ConfigurationChangeEvent) => {
			if (e.affectsConfiguration('lmstudio.baseUrl') || e.affectsConfiguration('lmstudio.apiKey') || e.affectsConfiguration('lmstudio.verboseLogging')) {
				this.log('Configuration changed, will refresh client on next request');
				this.loadVerbosity();
				// Reset the client so it gets recreated with new settings
				this.client = null;
				this.lastBaseUrl = null;
				this.lastApiKey = null;
				// Clear cache and notify of changes
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

	private ensureClient(): LMStudioClient | null {
		const baseUrl = this.getBaseUrl();
		const apiKey = this.getApiKey();

		// If we have a client and the settings haven't changed, reuse it
		if (this.client && this.lastBaseUrl === baseUrl && this.lastApiKey === apiKey) {
			return this.client;
		}

		// Create new client with current settings
		try {
			this.log(`Creating client with baseUrl: ${baseUrl}`);

			// Create client options with proper configuration
			const clientOptions: { baseUrl?: string; apiKey?: string } = {};

			// Only set baseUrl if it's not the default localhost:1234
			if (baseUrl !== 'http://localhost:1234') {
				clientOptions.baseUrl = baseUrl;
				this.log(`Using custom base URL: ${baseUrl}`);
			}

			// Add API key if provided
			if (apiKey) {
				clientOptions.apiKey = apiKey;
				this.log('Using API key for authentication');
			} else {
				this.log('No API key provided (OK for local instances)');
			}

			// Create client - if no custom options, use default constructor
			this.client = Object.keys(clientOptions).length > 0
				? new LMStudioClient(clientOptions)
				: new LMStudioClient();
			this.lastBaseUrl = baseUrl;
			this.lastApiKey = apiKey;

			this.log('Client created successfully');
			return this.client;
		} catch (error) {
			this.logError('Failed to create client', error);
			this.client = null;
			this.lastBaseUrl = null;
			this.lastApiKey = null;
			return null;
		}
	}

	private getBaseUrl(): string {
		// Check VS Code workspace configuration first
		const config = workspace.getConfiguration('lmstudio');
		const configUrl = config.get<string>('baseUrl');
		if (configUrl) {
			this.log('Using base URL from VS Code settings');
			return configUrl;
		}

		// Fall back to default
		this.log('Using default base URL');
		return 'http://localhost:1234';
	}

	private getApiKey(): string | null {
		// First try environment variable
		const envKey = process.env.LMSTUDIO_API_KEY;
		if (envKey) {
			this.log('Using API key from environment variable');
			return envKey;
		}

		// Then try VS Code workspace configuration
		const config = workspace.getConfiguration('lmstudio');
		const configKey = config.get<string>('apiKey');
		if (configKey) {
			this.log('Using API key from VS Code settings');
			return configKey;
		}

		this.log('No API key found (this is OK for local instances)');
		return null;
	}

	async prepareLanguageModelChat(_options: { silent: boolean; }, _token: CancellationToken): Promise<LanguageModelChatInformation[]> {
		// Check if we have cached models that are still valid
		const now = Date.now();
		if (this.cachedModels && (now - this.cacheTimestamp) < this.CACHE_DURATION) {
			this.log('Using cached models');
			return this.cachedModels;
		}

		// Try to get loaded models from LM Studio dynamically
		try {
			const client = this.ensureClient();
			if (!client) {
				this.log('Client not available, using fallback model');
				const fallbackModels = [
					getChatModelInfo("server-not-started", "🚨 Start LM Studio Server First!", 32768, 8192, false),
				];
				this.cachedModels = fallbackModels;
				this.cacheTimestamp = now;
				return fallbackModels;
			}

			// Test connection by trying to get loaded models
			this.log('Testing connection and fetching loaded models...');
			const loadedModels = await client.llm.listLoaded();
			this.log(`Successfully connected! Found ${loadedModels.length} loaded models`);

			// Convert LM Studio loaded models to VS Code model info
			const models: LanguageModelChatInformation[] = [];

			for (const model of loadedModels) {
				// Use the model identifier as both ID and name
				const id = model.identifier;
				const name = model.identifier; // LLM object doesn't have a separate display name

				// Get context length from model, use default if not available
				let maxInputTokens = 32768;
				try {
					maxInputTokens = await model.getContextLength();
				} catch (error) {
					this.logError(`Could not get context length for ${id}, using default`, error);
				}

				const maxOutputTokens = Math.min(8192, Math.floor(maxInputTokens / 4)); // Conservative output limit

				// Assume tool calling support for loaded models (can be refined later)
				const supportsTools = true;

				this.log(`Adding loaded model ${id} - Context: ${maxInputTokens}`);

				models.push(getChatModelInfo(id, name, maxInputTokens, maxOutputTokens, supportsTools));
			}

			// If we found loaded models, return them, otherwise provide helpful guidance
			if (models.length > 0) {
				this.cachedModels = models;
				this.cacheTimestamp = now;
				return models;
			} else {
				this.log('No models are currently loaded in LM Studio');
				const fallbackModels = [
					getChatModelInfo("no-models-loaded", "📱 Load a Model in LM Studio", 32768, 8192, false),
				];
				this.cachedModels = fallbackModels;
				this.cacheTimestamp = now;
				return fallbackModels;
			}

		} catch (error) {
			this.logError('Could not connect to LM Studio server', error);

			// Provide helpful error message based on the error type
			let errorModelName = "Connection Error - Check LM Studio";
			if (error instanceof Error) {
				this.logError('Connection error details', error);
				if (error.message.includes('ECONNREFUSED') || error.message.includes('connection')) {
					errorModelName = "🔌 Start LM Studio Server (Local Server tab)";
				} else if (error.message.includes('unauthorized') || error.message.includes('401')) {
					errorModelName = "🔐 Authentication Error (Check API key)";
				} else if (error.message.includes('timeout')) {
					errorModelName = "⏱️ Connection Timeout - Check Network";
				} else {
					errorModelName = `❌ Connection Error: ${error.message.substring(0, 40)}...`;
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

	/**
	 * Manually refresh the model cache. This can be called when users want to update
	 * the available models without waiting for the cache to expire.
	 */
	public refreshModels(): void {
		console.log('LM Studio: Manually refreshing model cache');
		this.cachedModels = null;
		this.cacheTimestamp = 0;
		this._onDidChange.fire();
	}

	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: Array<LanguageModelChatMessage>,
		options: LanguageModelChatRequestHandleOptions,
		progress: Progress<ChatResponseFragment2>,
		token: CancellationToken
	): Promise<void> {
		// Ensure client is initialized with current settings
		const client = this.ensureClient();
		const started = Date.now();
		this.log(`Chat request started with model='${model.id}' messages=${messages.length} maxTokens=${options.modelOptions?.maxTokens}`);

		if (!client) {
			progress.report({
				index: 0,
				part: new LanguageModelTextPart(
					"🚨 **LM Studio Server Not Started**\\n\\n" +
					"**Quick Fix Steps:**\\n" +
					"1. 🚀 **Open LM Studio application**\\n" +
					"2. 🌐 **Click the 'Local Server' tab at the top**\\n" +
					"3. ▶️ **Click 'Start Server' button**\\n" +
					"4. 📱 **Load a model** (click 'Select a model' if none loaded)\\n" +
					"5. 🔄 **Try your chat request again**\\n\\n" +
					"**Current settings:**\\n" +
					`• Connecting to: ${this.getBaseUrl()}\\n` +
					`• API Key: ${this.getApiKey() ? 'Configured' : 'None (OK for local)'}\\n\\n` +
					"💡 **Tip:** The server must be running AND have a model loaded to work!"
				)
			});
			return;
		}

		try {
		// Convert VS Code messages to LM Studio chat format
		const chatHistory = messages.map((msg, index) => {
			let content: string;
			if (Array.isArray(msg.content)) {
				content = msg.content.map(part => {
					if (part instanceof LanguageModelTextPart) {
						return part.value;
					} else if (part instanceof LanguageModelToolCallPart) {
						return `[Tool Call: ${part.name}(${JSON.stringify(part.input)})]`;
					}
					return '';
				}).join('');
			} else {
				content = msg.content;
			}

			// Map VS Code roles to LM Studio roles properly
			let role: 'user' | 'assistant' | 'system';
			switch (msg.role) {
				case LanguageModelChatMessageRole.User:
					role = 'user';
					break;
				case LanguageModelChatMessageRole.Assistant:
					role = 'assistant';
					break;
				default:
					// Treat unknown roles as user to avoid errors
					role = 'user';
					break;
			}

			const convertedMessage = { role, content };
			this.log(`Message ${index}: role=${msg.role}->${role} content=${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
			return convertedMessage;
		});			// Get a model instance - try to get the requested model or use the first available one
			let llmModel;
			try {
				if (model.id === "no-models-loaded" || model.id === "connection-error" || model.id === "server-not-started") {
					throw new Error("No models available or connection error. Please start LM Studio server and load a model.");
				}

				// Get list of currently loaded models
				const loadedModels = await client.llm.listLoaded();

				if (loadedModels.length === 0) {
					throw new Error("No models are currently loaded in LM Studio. Please load a model first.");
				}

				// Try to find the specific model requested
				llmModel = loadedModels.find(m => m.identifier === model.id);

				if (!llmModel) {
					// If specific model not found, use the first available one
					llmModel = loadedModels[0];
					this.log(`Requested model '${model.id}' not found, using: ${llmModel.identifier}`);
				} else {
					this.log(`Using requested model: ${llmModel.identifier}`);
				}

			} catch (loadError) {
				throw new Error(`No models available. Please load a model in LM Studio first. Error: ${loadError}`);
			}

			// Make the prediction with streaming
			const predictionOptions = {
				maxTokens: options.modelOptions?.maxTokens || 8192,
			};
			this.log(`Invoking respond() with options ${JSON.stringify(predictionOptions)} historyLength=${chatHistory.length}`);
			const prediction = llmModel.respond(chatHistory, predictionOptions);

			let index = 0;
			let receivedChars = 0;
			let firstFragmentTime: number | undefined;
			let skipThinkMode = false;
			let accumulatedContent = '';
			let lastReportTime = Date.now();
			const BATCH_DELAY_MS = 100; // Slightly longer delay for stability
			let fragmentCount = 0;

			// Helper function to flush accumulated content
			const flushContent = () => {
				if (accumulatedContent.trim().length > 0) {
					this.log(`Flushing batch ${index}: "${accumulatedContent.substring(0, 50)}${accumulatedContent.length > 50 ? '...' : ''}"`);
					try {
						progress.report({
							index: 0,
							part: new LanguageModelTextPart(accumulatedContent)
						});
						receivedChars += accumulatedContent.length;
						accumulatedContent = '';
						index++;
					} catch (error) {
						this.logError('Error reporting fragment', error);
					}
				}
			};

			// Stream the response
			for await (const fragment of prediction) {
				if (token.isCancellationRequested) {
					this.log('Cancellation requested by VS Code token');
					break;
				}

				if (fragment.content) {
					if (firstFragmentTime === undefined) {
						firstFragmentTime = Date.now();
						this.log(`First fragment received after ${firstFragmentTime - started}ms`);
					}

					const content = fragment.content;
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
						// Skip all content while in thinking mode
						this.log(`Fragment skipped (thinking mode): raw="${content}"`);
						continue;
					}

					// Skip empty structured tokens
					if (content === '<|channel|>final<|message|>' ||
						content === '<|start|>assistant' ||
						content === '<|end|>') {
						this.log(`Fragment skipped (empty token): raw="${content}"`);
						continue;
					}

					// Only accumulate non-empty content
					if (content.length > 0) {
						accumulatedContent += content;
						
						const now = Date.now();
						
						// More conservative flushing strategy
						const shouldFlush = 
							// Flush on paragraph breaks (double newlines)
							content.includes('\n\n') ||
							// Flush on code block boundaries  
							content.includes('```') ||
							// Flush if we've accumulated a reasonable amount
							accumulatedContent.length >= 50 ||
							// Flush if enough time has passed
							(now - lastReportTime) >= BATCH_DELAY_MS ||
							// Flush every 10 fragments to prevent too much accumulation
							(fragmentCount % 10 === 0);

						if (shouldFlush) {
							flushContent();
							lastReportTime = now;
						}
					}
				}
			}

			// Always flush any remaining content at the end
			flushContent();
			const ended = Date.now();
			this.log(`Streaming complete fragments=${index} chars=${receivedChars} duration=${ended-started}ms firstFragmentLatency=${firstFragmentTime?firstFragmentTime-started:'n/a'}ms`);

		} catch (error) {
			let errorMessage = 'Unknown error occurred';

			if (error instanceof Error) {
				errorMessage = error.message;

				// Provide more helpful error messages for common issues
				if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('connection')) {
					errorMessage = "🔌 **Cannot connect to LM Studio**\\n\\n" +
						"**Troubleshooting steps:**\\n" +
						"1. 🚀 Start LM Studio application\\n" +
						"2. 🌐 Go to 'Local Server' tab\\n" +
						"3. ▶️ Click 'Start Server'\\n" +
						"4. 📱 Load a model (click 'Select a model')\\n" +
						"5. ✅ Wait for model to load completely\\n" +
						"6. 🔄 Try your request again\\n\\n" +
						`**Current settings:**\\n` +
						`• Trying to connect to: ${this.getBaseUrl()}\\n` +
						`• API Key: ${this.getApiKey() ? 'Set' : 'Not required for local'}\\n\\n` +
						"**Quick fix:** Check LM Studio's 'Local Server' tab and ensure it shows 'Server running'.";
				} else if (errorMessage.includes('unauthorized') || errorMessage.includes('401')) {
					errorMessage = "🔐 **Authentication failed**\\n\\nPlease check your LM Studio API key in VS Code settings.";
				} else if (errorMessage.includes('No models available') || errorMessage.includes('No models are currently loaded')) {
					errorMessage = "📱 **No models loaded in LM Studio**\\n\\n" +
						"**Step-by-step fix:**\\n" +
						"1. 🚀 **Open LM Studio app**\\n" +
						"2. 🌐 **Go to 'Local Server' tab**\\n" +
						"3. ▶️ **Start the server** (if not already running)\\n" +
						"4. 📋 **Click 'Select a model to load'**\\n" +
						"5. ⚡ **Choose and load a model**\\n" +
						"6. ✅ **Wait for model to finish loading**\\n" +
						"7. 🔄 **Try your chat request again**\\n\\n" +
						"💡 **Quick check:** Look for a green indicator next to your model in LM Studio!";
				} else if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
					errorMessage = "⏱️ **Rate limit exceeded**\\n\\nPlease wait a moment and try again.";
				}
			}

			progress.report({
				index: 0,
				part: new LanguageModelTextPart(errorMessage)
			});
		}
	}

	async provideTokenCount(model: LanguageModelChatInformation, text: string | LanguageModelChatMessage, _token: CancellationToken): Promise<number> {
		try {
			let content: string;
			if (typeof text === 'string') {
				content = text;
			} else {
				content = Array.isArray(text.content)
					? text.content.map(part => part instanceof LanguageModelTextPart ? part.value : '').join('')
					: text.content;
			}

			// Use gpt-tokenizer for approximation since we don't know the exact tokenizer
			// Note: This gives an approximation since LM Studio models may use different tokenizers
			const tokens = encode(content);
			return tokens.length;
		} catch {
			// Fallback to simple estimation if tokenizer fails
			let content: string;
			if (typeof text === 'string') {
				content = text;
			} else {
				content = Array.isArray(text.content)
					? text.content.map(part => part instanceof LanguageModelTextPart ? part.value : '').join('')
					: text.content;
			}
			// Rough estimation: 1 token per 4 characters
			return Math.ceil(content.length / 4);
		}
	}
}