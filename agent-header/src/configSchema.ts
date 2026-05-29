export type HeaderConfig = {
	enabled?: boolean;
	name?: string;
	showGit?: boolean;
	showModel?: boolean;
	showDirectory?: boolean;
	colors?: Partial<ColorConfig>;
};

export type ColorConfig = {
	title: string;
	subtitle: string;
	separator: string;
};

export type ResolvedConfig = Required<Omit<HeaderConfig, "colors">> & {
	colors: ColorConfig;
};

export type ConfigLoadResult = {
	config: ResolvedConfig;
	loadedPaths: string[];
	warnings: string[];
	error?: string;
};

export const defaultConfig: ResolvedConfig = {
	enabled: true,
	name: "Sci-pi",
	showGit: true,
	showModel: true,
	showDirectory: true,
	colors: {
		title: "accent",
		subtitle: "muted",
		separator: "dim",
	},
};

export function mergeConfig(base: HeaderConfig, override: HeaderConfig): HeaderConfig {
	return {
		...base,
		...override,
		colors: {
			...(base.colors ?? {}),
			...(override.colors ?? {}),
		},
	};
}

export function resolveConfig(config: HeaderConfig): ResolvedConfig {
	return resolveConfigWithWarnings(config).config;
}

export function resolveConfigWithWarnings(config: HeaderConfig): ConfigLoadResult {
	const warnings: string[] = [];

	return {
		config: {
			...defaultConfig,
			...config,
			name: typeof config.name === "string" && config.name.length > 0
				? config.name
				: defaultConfig.name,
			colors: {
				...defaultConfig.colors,
				...(config.colors ?? {}),
			},
		},
		loadedPaths: [],
		warnings,
	};
}
