// ffprobe-static ships no types: it exports the resolved binary path for the current platform.
declare module 'ffprobe-static' {
  const ffprobe: { path: string };
  export = ffprobe;
}
