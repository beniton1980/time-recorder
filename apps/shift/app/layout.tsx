import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'ONOGAMI シフト',description:'勤務希望の提出と確認',robots:{index:false,follow:false}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="ja"><body>{children}</body></html>;}
