import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { ModalState, ModalConfig, ModalContextValue } from './types';
import { Modal } from './ModalManager';
import { WebAlertModal } from './components/WebAlertModal';
import { WebPromptModal } from './components/WebPromptModal';
import { CustomModal } from './components/CustomModal';
import {
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from '@/components/buzz/HullActionSheet';

const ModalContext = createContext<ModalContextValue | undefined>(undefined);

export function useModal() {
  const context = useContext(ModalContext);
  if (!context) {
    throw new Error('useModal must be used within a ModalProvider');
  }
  return context;
}

export function ModalProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ModalState>({
    modals: [],
  });

  const generateId = useCallback(() => {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }, []);

  const showModal = useCallback(
    (config: Omit<ModalConfig, 'id'>): string => {
      const id = generateId();
      const modalConfig: ModalConfig = { ...config, id } as ModalConfig;

      setState((prev) => ({
        modals: [...prev.modals, modalConfig],
      }));

      return id;
    },
    [generateId],
  );

  const hideModal = useCallback((id: string) => {
    setState((prev) => ({
      modals: prev.modals.filter((modal) => modal.id !== id),
    }));
  }, []);

  const hideAllModals = useCallback(() => {
    setState({ modals: [] });
  }, []);

  const dismissModal = useCallback(
    (modal: ModalConfig) => {
      if (modal.type === 'confirm') {
        Modal.resolveConfirm(modal.id, false);
      } else if (modal.type === 'prompt') {
        Modal.resolvePrompt(modal.id, null);
      }
      hideModal(modal.id);
    },
    [hideModal],
  );

  const dismissTopModal = useCallback(() => {
    const currentModal = state.modals[state.modals.length - 1];
    if (!currentModal) {
      return false;
    }
    dismissModal(currentModal);
    return true;
  }, [dismissModal, state.modals]);

  // Initialize ModalManager with functions
  useEffect(() => {
    Modal.setFunctions(showModal, hideModal, hideAllModals);
  }, [showModal, hideModal, hideAllModals]);

  const contextValue: ModalContextValue = {
    state,
    showModal,
    hideModal,
    hideAllModals,
    dismissTopModal,
  };

  const currentModal = state.modals[state.modals.length - 1];

  return (
    <ModalContext.Provider value={contextValue}>
      {children}
      {currentModal && (
        <>
          {currentModal.type === 'alert' && (
            <WebAlertModal config={currentModal} onClose={() => dismissModal(currentModal)} />
          )}
          {currentModal.type === 'confirm' && (
            <WebAlertModal
              config={currentModal}
              onClose={() => dismissModal(currentModal)}
              onConfirm={(value) => {
                Modal.resolveConfirm(currentModal.id, value);
                hideModal(currentModal.id);
              }}
            />
          )}
          {currentModal.type === 'prompt' && (
            <WebPromptModal
              config={currentModal}
              onConfirm={(value) => {
                Modal.resolvePrompt(currentModal.id, value);
                hideModal(currentModal.id);
              }}
            />
          )}
          {currentModal.type === 'action-sheet' && (
            <HullActionSheetModal
              onClose={() => hideModal(currentModal.id)}
              subtitle={currentModal.message}
              title={currentModal.title}
              visible
            >
              {currentModal.actions.map((action, index) => (
                <HullActionSheetRow
                  destructive={action.style === 'destructive'}
                  key={`${action.text}:${index}`}
                  label={action.text}
                  metadata={action.metadata}
                  onPress={() => {
                    hideModal(currentModal.id);
                    action.onPress?.();
                  }}
                />
              ))}
              <HullActionSheetCancel
                label={currentModal.cancelText}
                onPress={() => hideModal(currentModal.id)}
              />
            </HullActionSheetModal>
          )}
          {currentModal.type === 'custom' && (
            <CustomModal config={currentModal} onClose={() => hideModal(currentModal.id)} />
          )}
        </>
      )}
    </ModalContext.Provider>
  );
}
