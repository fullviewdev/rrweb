export type PackFn = (event: { timestamp: number }) => string;
export type UnpackFn = (raw: string) => { timestamp: number };

export type eventWithTimeAndPacker = { timestamp: number } & {
  v: string;
};

export const MARK = 'v1';
