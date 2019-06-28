export interface EnvVars extends Secrets, Omit<Cloudflare.Env, ''>, TypedBindings {
	GIT_HASH?: string;
}

interface Secrets {}

interface TypedBindings {}
