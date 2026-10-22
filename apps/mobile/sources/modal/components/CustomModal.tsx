import React from 'react';
import { BaseModal } from './BaseModal';
import { CustomModalConfig } from '../types';

interface CustomModalProps {
    config: CustomModalConfig;
    onClose: () => void;
}

export function CustomModal({ config, onClose }: CustomModalProps) {
    const Component = config.component;
    return (
        <BaseModal visible={true} onClose={onClose} placement={config.placement}>
            <Component {...config.props} onClose={onClose} />
        </BaseModal>
    );
}

