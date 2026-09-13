import type { Metadata } from 'next';
import ShiftTrial from './shift-trial';

export const metadata: Metadata = {
  title: 'ONOGAMI シフト｜操作テスト',
  description: 'シフト希望の提出と管理者確認を、架空のスタッフで試せます。',
  robots: { index: false, follow: false },
};

export default function ShiftTrialPage() { return <ShiftTrial />; }
