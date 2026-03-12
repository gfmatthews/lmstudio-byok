import * as vscode from 'vscode';
import { LMStudioChatModelProvider } from './provider';

export function activate(context: vscode.ExtensionContext) {
	const provider = new LMStudioChatModelProvider();

	// Register commands FIRST so they are always available even if
	// the language model provider registration fails.
	const refreshCommand = vscode.commands.registerCommand('lmstudio.refreshModels', () => {
		provider.refreshModels();
		vscode.window.showInformationMessage('LM Studio models refreshed');
	});
	context.subscriptions.push(refreshCommand);

	const testConnectionCommand = vscode.commands.registerCommand('lmstudio.testConnection', async () => {
		try {
			const models = await provider.provideLanguageModelChatInformation({ silent: false }, new vscode.CancellationTokenSource().token);

			if (models.some(m => m.id === 'connection-error' || m.id === 'no-models-loaded' || m.id === 'server-not-started')) {
				vscode.window.showErrorMessage(`LM Studio connection failed. Found: ${models.map(m => m.name).join(', ')}`);
			} else {
				vscode.window.showInformationMessage(`LM Studio connected successfully! Found ${models.length} models: ${models.map(m => m.name).join(', ')}`);
			}
		} catch (error) {
			vscode.window.showErrorMessage(`LM Studio connection test failed: ${error}`);
		}
	});
	context.subscriptions.push(testConnectionCommand);

	const showWelcomeCommand = vscode.commands.registerCommand('lmstudio.showWelcome', () => {
		showWelcomePage();
	});
	context.subscriptions.push(showWelcomeCommand);

	// Register the chat model provider (after commands, so a failure here
	// does not prevent commands from working).
	try {
		const disposable = vscode.lm.registerLanguageModelChatProvider('lmstudio', provider);
		context.subscriptions.push(disposable);
	} catch (error) {
		vscode.window.showErrorMessage(
			`LM Studio: Failed to register language model provider. ` +
			`Make sure you are running VS Code 1.110+ and have GitHub Copilot installed. Error: ${error}`
		);
	}

	// Show welcome page on first activation (with a small delay to ensure UI is ready)
	setTimeout(() => {
		const hasShownWelcome = context.globalState.get('lmstudio.welcomeShown', false);
		if (!hasShownWelcome) {
			showWelcomePage();
			context.globalState.update('lmstudio.welcomeShown', true);
		}
	}, 1000);
}

function showWelcomePage() {
	const panel = vscode.window.createWebviewPanel(
		'lmstudioWelcome',
		'LM Studio Setup Guide',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true
		}
	);

	panel.webview.html = getWelcomeContent();
}

function getWelcomeContent(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LM Studio Setup Guide</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            line-height: 1.6;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        h1, h2 {
            color: var(--vscode-textPreformat-foreground);
            margin-top: 30px;
        }
        h1 {
            border-bottom: 2px solid var(--vscode-textSeparator-foreground);
            padding-bottom: 10px;
        }
        .step {
            background: var(--vscode-textBlockQuote-background);
            border-left: 4px solid var(--vscode-textLink-foreground);
            padding: 15px;
            margin: 15px 0;
            border-radius: 4px;
        }
        .step-number {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
            font-size: 1.2em;
        }
        .command {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px 12px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            margin: 5px 0;
            display: inline-block;
        }
        .warning {
            background: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            padding: 10px;
            border-radius: 4px;
            margin: 10px 0;
        }
        .success {
            background: var(--vscode-inputValidation-infoBackground);
            border: 1px solid var(--vscode-inputValidation-infoBorder);
            padding: 10px;
            border-radius: 4px;
            margin: 10px 0;
        }
        .settings-code {
            background: var(--vscode-textCodeBlock-background);
            padding: 15px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
            margin: 10px 0;
            white-space: pre-wrap;
        }
        ul {
            margin: 10px 0;
            padding-left: 20px;
        }
        li {
            margin: 5px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Welcome to LM Studio BYOK Chat Provider</h1>

        <div class="success">
            <strong>Extension Activated!</strong> Follow the steps below to start using local LLMs with GitHub Copilot Chat.
        </div>

        <h2>📋 Quick Setup Steps</h2>

        <div class="step">
            <div class="step-number">Step 1: Download LM Studio</div>
            <p>If you haven't already, download LM Studio from <strong>lmstudio.ai</strong></p>
            <ul>
                <li>Free download for Windows, Mac, and Linux</li>
                <li>No account required</li>
            </ul>
        </div>

        <div class="step">
            <div class="step-number">Step 2: Download a Model</div>
            <p>In LM Studio, go to the <strong>Discover</strong> tab and download a model:</p>
            <ul>
                <li><strong>Recommended for beginners:</strong> Qwen2.5-7B-Instruct (4.68 GB)</li>
                <li><strong>For better performance:</strong> Meta-Llama-3.1-8B-Instruct (4.92 GB)</li>
                <li><strong>Lightweight option:</strong> Ministral-8B-Instruct (4.67 GB)</li>
            </ul>
        </div>

        <div class="step">
            <div class="step-number">Step 3: Start the Local Server</div>
            <p>In LM Studio:</p>
            <ul>
                <li>Click the <strong>"Local Server"</strong> tab</li>
                <li>Click <strong>"Start Server"</strong></li>
                <li>Load a model by clicking <strong>"Select a model"</strong></li>
                <li>Wait for the model to finish loading (green indicator)</li>
            </ul>
        </div>

        <div class="step">
            <div class="step-number">Step 4: Test Your Connection</div>
            <p>Use VS Code commands to verify everything works:</p>
            <div class="command">Ctrl+Shift+P → "LM Studio: Test Connection"</div>
            <div class="command">Ctrl+Shift+P → "LM Studio: Refresh Available Models"</div>
        </div>

        <div class="step">
            <div class="step-number">Step 5: Start Chatting!</div>
            <p>Open GitHub Copilot Chat and select your LM Studio model from the model picker. Look for models with the "LM Studio" family name.</p>
        </div>

        <h2>⚙️ Configuration (Optional)</h2>

        <p>You can customize settings in VS Code Settings (Ctrl+,) by searching for "LM Studio":</p>

        <div class="settings-code">{
  "lmstudio.baseUrl": "http://localhost:1234",
  "lmstudio.apiKey": "your-api-key-here",
  "lmstudio.verboseLogging": false
}</div>

        <div class="warning">
            <strong>Note:</strong> API key is optional for local instances. Only needed if you're connecting to a remote LM Studio server.
        </div>

        <h2>🐛 Troubleshooting</h2>

        <div class="step">
            <div class="step-number">Enable Diagnostic Logging</div>
            <p>For detailed troubleshooting, enable verbose logging:</p>
            <ul>
                <li>Go to VS Code Settings</li>
                <li>Search for "lmstudio.verboseLogging"</li>
                <li>Enable it</li>
                <li>Check the "LM Studio" output channel for detailed logs</li>
            </ul>
        </div>

        <div class="step">
            <div class="step-number">Common Issues</div>
            <ul>
                <li><strong>Connection refused:</strong> Make sure LM Studio server is running</li>
                <li><strong>No models available:</strong> Load a model in LM Studio's Local Server tab</li>
                <li><strong>Weird response formatting:</strong> The extension now filters out model artifacts automatically</li>
                <li><strong>Slow responses:</strong> Try a smaller model or check your system resources</li>
            </ul>
        </div>

        <h2>🎯 Need Help?</h2>
        <p>
            <strong>Commands available:</strong><br>
            • <span class="command">LM Studio: Test Connection</span> - Verify server connectivity<br>
            • <span class="command">LM Studio: Refresh Available Models</span> - Update model list<br>
            • <span class="command">LM Studio: Show Welcome</span> - Show this guide again
        </p>

        <div class="success">
            <strong>Happy coding with local LLMs! 🎉</strong><br>
            Your privacy is protected - everything runs locally on your machine.
        </div>
    </div>
</body>
</html>`;
}

export function deactivate() { }