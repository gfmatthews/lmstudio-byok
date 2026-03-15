import * as vscode from 'vscode';
import { LMStudioChatModelProvider } from './provider';

/** Represents a single model in the tree view. */
export class ModelTreeItem extends vscode.TreeItem {
	constructor(
		public readonly modelId: string,
		public readonly modelName: string,
		public readonly visible: boolean,
	) {
		super(modelName, vscode.TreeItemCollapsibleState.None);
		this.description = visible ? '' : 'hidden';
		this.iconPath = new vscode.ThemeIcon(visible ? 'eye' : 'eye-closed');
		this.contextValue = visible ? 'model-visible' : 'model-hidden';
		this.tooltip = visible
			? `${modelName} — visible in Copilot chat`
			: `${modelName} — hidden from Copilot chat`;
		this.command = {
			command: 'lmstudio.toggleModelVisibility',
			title: 'Toggle Visibility',
			arguments: [this],
		};
	}
}

export class LMStudioModelTreeProvider implements vscode.TreeDataProvider<ModelTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<ModelTreeItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly provider: LMStudioChatModelProvider) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: ModelTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(): Promise<ModelTreeItem[]> {
		const models = await this.provider.getAllModels();
		if (!models || models.length === 0) {
			return [];
		}

		return models.map(m => {
			const visible = this.provider.isModelVisible(m.id);
			return new ModelTreeItem(m.id, m.name, visible);
		});
	}
}
