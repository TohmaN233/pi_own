import type { Metadata } from 'next';
import { ModePackManager } from '../../components/mode-pack-manager';

export const metadata: Metadata = {
  title: 'Mode Pack',
  description: 'Create and publish versioned Pi Mode Packs.',
};

export default function ModePacksPage() {
  return <ModePackManager />;
}
