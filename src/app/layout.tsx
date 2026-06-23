import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SCS → STL Converter | Direct ZSTD 3D Model Converter",
  description: "Convert HOOPS Stream Cache (.scs) files to STL format with 3D preview. Fast, private, browser-based conversion using direct ZSTD decompression.",
  keywords: ["SCS to STL", "HOOPS", "3D model converter", "STL converter", "3D printing", "Thangs", "stream cache"],
  authors: [{ name: "SCS Converter" }],
  icons: {
    icon: "/favicon.ico",
  },
  openGraph: {
    title: "SCS → STL Converter",
    description: "Convert HOOPS SCS files to STL with 3D preview",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
