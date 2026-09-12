import { isRunningOnMac } from '@/utils/platform';

function getMaxWidth(): number {
    if (isRunningOnMac()) {
        return Number.POSITIVE_INFINITY;
    }

    return 800;
}

function getMaxLayoutWidth(): number {
    if (isRunningOnMac()) {
        return 1400;
    }

    return 800;
}

export const layout = {
    maxWidth: getMaxLayoutWidth(),
    headerMaxWidth: getMaxWidth()
}
