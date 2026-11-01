export declare function which(name: string, envPath?: string): string | undefined;
/** Directory holding the `git` executable. */
export declare function gitBinDir(): string;
/** Variables a minimal child env still needs on Windows (process start-up, temp dirs, home lookup). */
export declare function windowsBaseEnv(home: string): NodeJS.ProcessEnv;
