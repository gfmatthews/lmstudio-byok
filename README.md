# LM Studio BYOK Chat Provider

This VS Code extension provides access to local LLM models running in LM Studio through VS Code's Language Model API, allowing you to use local models with GitHub Copilot Chat and other VS Code AI features.

## Features

- 🖥️ **Local Inference**: Run models completely locally for full privacy
- 🚀 **High Performance**: Direct integration with LM Studio for optimal performance
- 🔄 **Streaming Responses**: Real-time response streaming
- 🛠️ **Tool Calling**: Function calling support (if supported by the model)
- 🔌 **Easy Setup**: Minimal configuration required
- 🏷️ **Model Variety**: Support for Llama, Qwen, CodeGemma, Phi, and other popular models

## Prerequisites

1. **VS Code**: Version 1.103.0 or higher
2. **LM Studio**: Downloaded and installed from [lmstudio.ai](https://lmstudio.ai/)
3. **Node.js**: For development and building the extension

## Setup

### 1. Install LM Studio
Download and install LM Studio from [lmstudio.ai](https://lmstudio.ai/)

### 2. Load a Model in LM Studio
1. Open LM Studio
2. Browse and download a model (e.g., Llama 3.2, Qwen 2.5, etc.)
3. Load the model into memory

> 💡 **Tip:** Not sure which model will run well on your hardware? Check [canirun.ai](https://www.canirun.ai) to find the best model for your system.

### 3. Start the LM Studio Server
1. In LM Studio, go to the "Local Server" tab
2. Click "Start Server" (default: http://localhost:1234)
3. Note the server URL if you changed the default port

### 4. Configure VS Code Settings
```json
{
  // Optional: Set custom base URL if not using default
  "lmstudio.baseUrl": "http://localhost:1234",
  
  // Optional: Set API key if your LM Studio instance requires authentication
  "lmstudio.apiKey": "your_api_key_here"
}
```

Or set environment variables:
```bash
# Optional: Custom base URL
export LMSTUDIO_BASE_URL="http://localhost:1234"

# Optional: API key
export LMSTUDIO_API_KEY="your_api_key_here"
```

### 5. Install and Activate Extension
1. Build the extension: `npm run compile`
2. Open VS Code
3. Press F5 to launch Extension Development Host
4. The LM Studio models should appear in the VS Code chat model picker

## Usage

Once configured, you can use LM Studio models in:

- **GitHub Copilot Chat**: Select "LM Studio" provider in the model picker
- **VS Code Chat**: Access through the chat interface
- **Other Extensions**: Any extension using the VS Code Language Model API

## Configuration Options

### VS Code Settings

- `lmstudio.baseUrl`: Base URL for LM Studio server (default: "http://localhost:1234")
- `lmstudio.apiKey`: API key for authentication (optional for local instances)

### Environment Variables

- `LMSTUDIO_API_KEY`: API key for LM Studio authentication
- `LMSTUDIO_BASE_URL`: Base URL for LM Studio server

## Supported Models

The extension provides access to common model types including:

- Llama 3.2 (1B, 3B Instruct)
- Llama 3.1 (8B Instruct)
- Qwen 2.5 (7B Instruct)
- CodeGemma (7B Instruct)
- Phi-3.5 (Mini Instruct)
- DeepSeek R1 Distill Llama 8B
- Any loaded model in LM Studio

> 💡 **Tip:** To find the best model for your hardware, visit [canirun.ai](https://www.canirun.ai).

## Development

### Building
```bash
npm install
npm run compile
```

### Debugging
```bash
npm run watch    # Watch for changes
npm run lint     # Run linter
```

### Testing
1. Start LM Studio with a loaded model
2. Press F5 in VS Code to launch Extension Development Host
3. Test chat functionality with the LM Studio provider

## Troubleshooting

### Models not appearing
- Ensure LM Studio is running and server is started
- Check VS Code Developer Console for errors
- Verify the extension compiled successfully (`npm run compile`)

### Connection errors
- Confirm LM Studio server is running on the configured port
- Check your `lmstudio.baseUrl` setting
- Ensure no firewall is blocking the connection

### No models loaded
- Load at least one model in LM Studio
- Verify the model is loaded in LM Studio's interface
- Try using the "Any Loaded Model" option

### Performance issues
- Ensure your system meets LM Studio's requirements
- Consider using smaller models for better performance
- Check LM Studio's GPU acceleration settings

## API Reference

This extension uses the [LM Studio SDK](https://github.com/lmstudio-ai/lmstudio-js) for communication with LM Studio.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test with a local LM Studio instance
5. Submit a pull request

## License

This extension follows the same license as the parent repository.