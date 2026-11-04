declare module 'draco3dgltf' {
  interface DracoModule {
    createEncoderModule(): Promise<unknown>;
    createDecoderModule(): Promise<unknown>;
  }
  const draco3d: DracoModule;
  export default draco3d;
}
