// Type declarations so TypeScript accepts image imports in this sample (a bundler such as Vite provides them).
declare module '*.svg' { const src: string; export default src; }
declare module '*.png' { const src: string; export default src; }
declare module '*.jpg' { const src: string; export default src; }
declare module '*.gif' { const src: string; export default src; }
declare module '*.webp' { const src: string; export default src; }
declare module '*.avif' { const src: string; export default src; }
declare const require: (path: string) => string;
declare namespace JSX { interface IntrinsicElements { [name: string]: unknown } }
