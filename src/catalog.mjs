export const CATALOG = [
  {
    id: 'manifest.fetch',
    category: 'publication',
    severity: 'error',
    title: 'Manifest is fetchable',
    hint: 'Serve /agent-manifest.json with HTTP 200 and an application/json content type.',
    specRef: 'MVP 3.3'
  },
  {
    id: 'manifest.required',
    category: 'publication',
    severity: 'error',
    title: 'Manifest declares networks',
    hint: 'Add a non-empty networks array; each entry needs unique name, front_man and hocon strings.',
    specRef: 'MVP 2.1, 3.3'
  },
  {
    id: 'manifest.cors',
    category: 'publication',
    severity: 'error',
    title: 'Manifest is CORS-readable',
    hint: 'Send Access-Control-Allow-Origin: * (or the caller origin) so peers can fetch the manifest.',
    specRef: 'MVP 3.3, 3.4'
  },
  {
    id: 'hosting.https',
    category: 'publication',
    severity: 'error',
    title: 'Site is served over HTTPS',
    hint: 'Serve the site over HTTPS; plain HTTP is only accepted for loopback development.',
    specRef: 'MVP 3.4'
  },
  {
    id: 'links.fetch',
    category: 'publication',
    severity: 'error',
    title: 'Link map is fetchable',
    hint: 'Publish links.json or ensure it returns HTTP 200 JSON when present.',
    specRef: 'MVP 3.3'
  },
  {
    id: 'links.valid',
    category: 'publication',
    severity: 'error',
    title: 'Link map is valid',
    hint: 'Set version to 1 and map each network to symbolic -> absolute http(s) URLs.',
    specRef: 'MVP 3.3'
  },
  {
    id: 'network.fetch',
    category: 'network',
    severity: 'error',
    title: 'Network artifact is fetchable',
    hint: 'Serve the HOCON/JSON network artifact with HTTP 200 and a JSON body.',
    specRef: 'MVP 3.3'
  },
  {
    id: 'network.cors',
    category: 'network',
    severity: 'error',
    title: 'Network artifact is CORS-readable',
    hint: 'Send Access-Control-Allow-Origin: * from the network artifact response.',
    specRef: 'MVP 3.3'
  },
  {
    id: 'network.tools',
    category: 'network',
    severity: 'error',
    title: 'Network declares tools',
    hint: 'Give the network a non-empty tools array.',
    specRef: 'MVP 2.1'
  },
  {
    id: 'network.duplicates',
    category: 'network',
    severity: 'error',
    title: 'Agent names are unique',
    hint: 'Give every agent a unique, non-empty name.',
    specRef: 'MVP 2.1'
  },
  {
    id: 'network.front_man',
    category: 'network',
    severity: 'error',
    title: 'Front agent resolves',
    hint: 'Point front_man at exactly one declared agent name.',
    specRef: 'MVP 2.1, 3.2'
  },
  {
    id: 'network.agent.fields',
    category: 'network',
    severity: 'error',
    title: 'Agent fields are well formed',
    hint: 'Each agent needs function.description; declare tools: [] explicitly for leaf agents; instructions must be a string of at most 20,000 characters when present.',
    specRef: 'MVP 2.1'
  },
  {
    id: 'network.descriptions',
    category: 'network',
    severity: 'warn',
    title: 'Agent descriptions are useful',
    hint: 'Write descriptions of at least 20 characters so peers can judge the agent.',
    specRef: 'MVP 2.1'
  },
  {
    id: 'network.refs',
    category: 'network',
    severity: 'error',
    title: 'Tool references resolve',
    hint: 'Reference a local agent name or an absolute http(s) URL; descriptor objects need a string url.',
    specRef: 'MVP 2.1, 2.2'
  },
  {
    id: 'network.budget',
    category: 'execution',
    severity: 'warn',
    title: 'Execution budget is bounded',
    hint: 'Set max_execution_seconds on the network.',
    specRef: 'MVP 3.1'
  },
  {
    id: 'network.agent_count',
    category: 'execution',
    severity: 'warn',
    title: 'Agent count is reasonable',
    hint: 'Keep networks at or below 50 agents; more than 200 agents is an error.',
    specRef: 'MVP 3.1'
  },
  {
    id: 'peers.allowed',
    category: 'composition',
    severity: 'error',
    title: 'Peer origins are allowed',
    hint: 'List each peer origin in allowed_peers or use peer_policy mode open.',
    specRef: 'MVP 3.2'
  },
  {
    id: 'actions.module',
    category: 'composition',
    severity: 'error',
    title: 'Actions module is loadable',
    hint: 'Declare actions.module and a non-empty agentTools array; the module URL must return 200.',
    specRef: 'MVP 3.1'
  },
  {
    id: 'inference.configured',
    category: 'inference',
    severity: 'warn',
    title: 'Inference router is configured',
    hint: 'Add llm_router.base_url (or byok_router) so a runtime can reach a model.',
    specRef: 'MVP 4'
  },
  {
    id: 'inference.router_https',
    category: 'inference',
    severity: 'warn',
    title: 'Inference router uses HTTPS',
    hint: 'Point the router at an https URL (loopback exempt).',
    specRef: 'MVP 4'
  },
  {
    id: 'security.secrets',
    category: 'security',
    severity: 'error',
    title: 'No credentials in published artifacts',
    hint: 'Remove secrets from published artifacts; these files are public.',
    specRef: 'MVP 5'
  },
  {
    id: 'security.script_vectors',
    category: 'security',
    severity: 'warn',
    title: 'Instructions contain no script vectors',
    hint: 'Remove <script> tags, javascript: URLs and inline event handlers from instructions.',
    specRef: 'MVP 5'
  },
  {
    id: 'integrity.changed',
    category: 'security',
    severity: 'warn',
    title: 'Artifacts unchanged since last audit',
    hint: 'Review the artifact change and re-consent before trusting the peer.',
    specRef: 'MVP 6'
  }
];

export const CATALOG_BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]));
