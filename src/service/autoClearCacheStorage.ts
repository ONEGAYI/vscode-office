import { type ExtensionContext } from 'vscode';
import { isWebExtensionHost } from '@/common/extensionHost';

const WEB_STORAGE_CLEARED_KEY = 'office.legacyWebStorageCleared';

/** 保留迁移标记，旧版产品级 WebStorage 清理已经停用。 */
export async function autoClearCacheStorage(context: ExtensionContext) {
	if (isWebExtensionHost()) {
		return;
	}
	if (context.globalState.get<boolean>(WEB_STORAGE_CLEARED_KEY)) {
		return;
	}
	await context.globalState.update(WEB_STORAGE_CLEARED_KEY, true);
}
