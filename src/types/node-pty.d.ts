declare module "node-pty" {
  export interface IPty {
    pid: number;
    cols: number;
    rows: number;
    onData(listener: (data: string) => void): { dispose(): void };
    onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
    write(data: string): boolean | void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    pause(): void;
    resume(): void;
  }

  export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: { [key: string]: string };
    encoding?: string;
    useConpty?: boolean;
    conptyInheritCursor?: boolean;
  }

  export function spawn(file: string, args: string[] | string, options: IPtyForkOptions): IPty;
}
