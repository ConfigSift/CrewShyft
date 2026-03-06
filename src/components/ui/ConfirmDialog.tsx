'use client';

import type { ReactNode } from 'react';
import { Modal } from '../Modal';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  loadingText?: string;
  variant?: 'danger' | 'default';
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
  isLoading?: boolean;
  children?: ReactNode;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = 'Delete',
  cancelText = 'Cancel',
  loadingText = 'Working...',
  variant = 'danger',
  onConfirm,
  onCancel,
  isLoading = false,
  children,
}: ConfirmDialogProps) {
  const confirmClass =
    variant === 'danger'
      ? 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-600/70'
      : 'bg-amber-500 text-zinc-900 hover:bg-amber-400 disabled:bg-amber-500/70';

  return (
    <Modal
      isOpen={open}
      onClose={isLoading ? () => {} : onCancel}
      title={title}
      size="sm"
      mobileFullScreen={false}
    >
      <div className="space-y-4">
        {description ? <p className="text-sm text-theme-muted">{description}</p> : null}
        {children}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            className="px-3 py-2 rounded-md border border-theme-primary text-sm text-theme-secondary hover:bg-theme-hover disabled:opacity-60"
            onClick={onCancel}
            disabled={isLoading}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={`px-3 py-2 rounded-md text-sm font-semibold transition-colors disabled:cursor-not-allowed ${confirmClass}`}
            onClick={() => {
              void onConfirm();
            }}
            disabled={isLoading}
          >
            {isLoading ? loadingText : confirmText}
          </button>
        </div>
      </div>
    </Modal>
  );
}
