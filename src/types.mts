export interface EnvVars extends Secrets, Cloudflare.Env, TypedBindings {
	GIT_HASH?: string;
}

interface Secrets {
	CF_ACCOUNT_ID: string;
	CF_API_TOKEN: string;
	CONFIG: string;
}

interface TypedBindings {}
