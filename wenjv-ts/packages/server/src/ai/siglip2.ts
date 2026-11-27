export const SIGLIP2_DIM = 768;

/**
 * Cloud-lite 占位实现：不加载本地 SigLIP2 ONNX 视觉模型，
 * isVisionSupported() 恒返回 false，以图搜图自动降级。
 */
export class SigLIP2Engine {
  async init(): Promise<void> {
    // Cloud-lite 模式无需加载本地 SigLIP2 模型
  }

  isVisionSupported(): boolean {
    return false;
  }

  async embedImage(_imageBuffer: Buffer): Promise<number[]> {
    return new Array(SIGLIP2_DIM).fill(0);
  }

  async embedText(_text: string): Promise<number[]> {
    return new Array(SIGLIP2_DIM).fill(0);
  }
}

let _siglip2: SigLIP2Engine | null = null;

export function getSigLIP2(): SigLIP2Engine {
  if (!_siglip2) {
    _siglip2 = new SigLIP2Engine();
  }
  return _siglip2;
}
