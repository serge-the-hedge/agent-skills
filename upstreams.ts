/** A skill set this repo vendors into vendor/<name> with `agent-skills update`. */
export type Upstream = {
  /** GitHub `owner/repo`. */
  repo: string;
  branch: string;
  /** Which of its skills to link into the agent skill folders: "all", or a list of skill names. */
  link: "all" | readonly string[];
};

export const upstreams = {
  // poteto's pstack (cursor/plugins), ported to T3 Code.
  pstack: { repo: "mariusflorescu/pstack-t3", branch: "main", link: "all" },
  // A list rather than "all": Matt's tdd and teach would clash with pstack's.
  matt: {
    repo: "mattpocock/skills",
    branch: "main",
    link: [
      "ask-matt",
      "code-review",
      "codebase-design",
      "diagnosing-bugs",
      "domain-modeling",
      "grill-me",
      "grill-with-docs",
      "grilling",
      "handoff",
      "implement",
      "improve-codebase-architecture",
      "prototype",
      "research",
      "setup-matt-pocock-skills",
      "to-questionnaire",
      "to-spec",
      "to-tickets",
      "triage",
      "wait-what",
      "wayfinder",
      "wizard",
      "writing-for-agents",
    ],
  },
  "good-css": { repo: "vojtaholik/good-css", branch: "main", link: "all" },
} satisfies Record<string, Upstream>;
