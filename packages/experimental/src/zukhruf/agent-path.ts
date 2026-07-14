/** Canonical model-facing address for one agent in a Zukhruf tree. */
export class AgentPath {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static root(): AgentPath {
    return new AgentPath('/root');
  }

  static parse(value: string): AgentPath {
    const path = value.trim();
    if (path !== '/root' && !path.startsWith('/root/')) {
      throw new Error(`agent path "${value}" must start at /root`);
    }

    const segments = path.slice(1).split('/');
    if (
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment !== segment.trim() ||
          segment === '.' ||
          segment === '..',
      )
    ) {
      throw new Error(`agent path "${value}" contains an invalid segment`);
    }
    return new AgentPath(path);
  }

  /** Relative targets name descendants; absolute targets keep their canonical path. */
  resolve(target: string): AgentPath {
    const requested = target.trim();
    if (!requested) throw new Error('agent path cannot be empty');
    return AgentPath.parse(
      requested.startsWith('/') ? requested : `${this.#value}/${requested}`,
    );
  }

  contains(candidate: AgentPath): boolean {
    return (
      this.equals(candidate) || candidate.#value.startsWith(`${this.#value}/`)
    );
  }

  equals(other: AgentPath): boolean {
    return this.#value === other.#value;
  }

  get isRoot(): boolean {
    return this.#value === '/root';
  }

  get parent(): AgentPath | null {
    if (this.isRoot) return null;
    return AgentPath.parse(this.#value.slice(0, this.#value.lastIndexOf('/')));
  }

  toString(): string {
    return this.#value;
  }
}
