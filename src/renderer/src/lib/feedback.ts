// Toasts and confirm dialogs. Both render text only: messages can quote
// agent-written content, so nothing here is ever treated as markup.
import { ElMessage, ElMessageBox } from 'element-plus';
import { ref } from 'vue';

// Open message boxes, so page shortcuts (Escape) leave them alone.
export const openDialogs = ref(0);

const tracked = async <T>(promise: Promise<T>) => {
  openDialogs.value += 1;
  try {
    return await promise;
  } finally {
    openDialogs.value -= 1;
  }
};

export type ToastTone = 'success' | 'error' | 'info';

// `tone` defaults from the wording: messages ending in 失败 or carrying an
// error description read as errors. Pass it explicitly when that guess is off.
export const showToast = (message: string, tone: ToastTone = /失败|无效|无法/.test(message) ? 'error' : 'success') => {
  ElMessage({ message, type: tone === 'error' ? 'error' : tone === 'info' ? 'info' : 'success', duration: 2800, customClass: 'glass-strong', grouping: true });
};

export type ConfirmOptions = { title: string; body: string; accept: string; danger?: boolean };

// Resolves true when the user accepts.
export const confirmAction = async ({ title, body, accept, danger = false }: ConfirmOptions) => {
  try {
    await tracked(ElMessageBox.confirm(body, title, {
      confirmButtonText: accept,
      cancelButtonText: '取消',
      type: 'warning',
      customClass: danger ? 'glass-strong confirm-danger' : 'glass-strong',
      confirmButtonClass: danger ? 'el-button--danger' : undefined,
    }));
    return true;
  } catch {
    return false;
  }
};

// A three-way choice: 'accept', 'alternate', or false when dismissed.
export const confirmChoice = async ({ title, body, accept, alternate }: ConfirmOptions & { alternate: string }) => {
  try {
    await tracked(ElMessageBox.confirm(body, title, {
      confirmButtonText: accept,
      cancelButtonText: alternate,
      distinguishCancelAndClose: true,
      type: 'warning',
      customClass: 'glass-strong',
    }));
    return 'accept' as const;
  } catch (action) {
    return action === 'cancel' ? 'alternate' as const : false;
  }
};
