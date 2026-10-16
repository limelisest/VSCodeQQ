// image-size exposes this subpath through package exports; the project's Node
// module resolution predates exports-aware type lookup.
declare module 'image-size/fromFile' {
  export function imageSizeFromFile(filePath: string): Promise<ReturnType<typeof import('image-size').imageSize>>;
}
