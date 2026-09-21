import type { Metadata, Viewport } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
import './globals.css'
const jakarta = Plus_Jakarta_Sans({subsets:['latin'],variable:'--font-jakarta'})
export const metadata:Metadata={title:'Valurise',description:'Sua vida financeira, com clareza.',manifest:'/manifest.webmanifest',icons:{icon:'/valurise-icon.webp',apple:'/valurise-icon.webp'}}
export const viewport:Viewport={themeColor:'#12131a',width:'device-width',initialScale:1}
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="pt-BR" className={jakarta.variable}><body>{children}</body></html>}
