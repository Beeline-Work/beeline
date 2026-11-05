import { usePathname } from 'expo-router';
import BuzzChannels from './beeline/channels';

/** The signed-in root is the Room deck; deep-linked screens own their landing. */
export default function Index() {
  return usePathname() === '/' ? <BuzzChannels /> : null;
}
