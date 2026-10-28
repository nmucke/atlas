// News source fetchers: pure network + parsing, no database access.
// Every request goes through an injectable fetcher so tests never touch the network.
import { isIP } from 'node:net';
import type {
  NewsItemKind,
  NewsSource,
  NewsSourceInput,
  NewsSourceKind,
  NewsSourceSuggestion,
  RawNewsItem,
} from '../shared/news.ts';

export interface FetchContext {
  fetcher: typeof fetch;
  contactEmail: string;
  openAlexKey: string | null;
  since: string | null; // ISO; null = default window (7 days)
}

const FEED_LIMIT = 5 * 1024 * 1024;
const JSON_LIMIT = 8 * 1024 * 1024;
const TIMEOUT = 20000;
const MAX_REDIRECTS = 5;
const ABSTRACT_LIMIT = 5000;
const FEED_ITEM_LIMIT = 300;
const DEFAULT_WINDOW_DAYS = 7;
const OPENALEX = 'https://api.openalex.org';
const OPENALEX_KEY_MESSAGE = 'OpenAlex needs a free API key — add it in News → Sources → Settings';
const FEED_ACCEPT =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5';

// ---------------------------------------------------------------------------
// arXiv categories (archives and subject classes accepted by rss.arxiv.org)

export const ARXIV_CATEGORIES: Readonly<Record<string, string>> = {
  'astro-ph': 'Astrophysics',
  'astro-ph.CO': 'Cosmology and Nongalactic Astrophysics',
  'astro-ph.EP': 'Earth and Planetary Astrophysics',
  'astro-ph.GA': 'Astrophysics of Galaxies',
  'astro-ph.HE': 'High Energy Astrophysical Phenomena',
  'astro-ph.IM': 'Instrumentation and Methods for Astrophysics',
  'astro-ph.SR': 'Solar and Stellar Astrophysics',
  'cond-mat': 'Condensed Matter',
  'cond-mat.dis-nn': 'Disordered Systems and Neural Networks',
  'cond-mat.mes-hall': 'Mesoscale and Nanoscale Physics',
  'cond-mat.mtrl-sci': 'Materials Science',
  'cond-mat.other': 'Other Condensed Matter',
  'cond-mat.quant-gas': 'Quantum Gases',
  'cond-mat.soft': 'Soft Condensed Matter',
  'cond-mat.stat-mech': 'Statistical Mechanics',
  'cond-mat.str-el': 'Strongly Correlated Electrons',
  'cond-mat.supr-con': 'Superconductivity',
  'gr-qc': 'General Relativity and Quantum Cosmology',
  'hep-ex': 'High Energy Physics - Experiment',
  'hep-lat': 'High Energy Physics - Lattice',
  'hep-ph': 'High Energy Physics - Phenomenology',
  'hep-th': 'High Energy Physics - Theory',
  'math-ph': 'Mathematical Physics',
  nlin: 'Nonlinear Sciences',
  'nlin.AO': 'Adaptation and Self-Organizing Systems',
  'nlin.CD': 'Chaotic Dynamics',
  'nlin.CG': 'Cellular Automata and Lattice Gases',
  'nlin.PS': 'Pattern Formation and Solitons',
  'nlin.SI': 'Exactly Solvable and Integrable Systems',
  'nucl-ex': 'Nuclear Experiment',
  'nucl-th': 'Nuclear Theory',
  physics: 'Physics',
  'physics.acc-ph': 'Accelerator Physics',
  'physics.ao-ph': 'Atmospheric and Oceanic Physics',
  'physics.app-ph': 'Applied Physics',
  'physics.atm-clus': 'Atomic and Molecular Clusters',
  'physics.atom-ph': 'Atomic Physics',
  'physics.bio-ph': 'Biological Physics',
  'physics.chem-ph': 'Chemical Physics',
  'physics.class-ph': 'Classical Physics',
  'physics.comp-ph': 'Computational Physics',
  'physics.data-an': 'Data Analysis, Statistics and Probability',
  'physics.ed-ph': 'Physics Education',
  'physics.flu-dyn': 'Fluid Dynamics',
  'physics.gen-ph': 'General Physics',
  'physics.geo-ph': 'Geophysics',
  'physics.hist-ph': 'History and Philosophy of Physics',
  'physics.ins-det': 'Instrumentation and Detectors',
  'physics.med-ph': 'Medical Physics',
  'physics.optics': 'Optics',
  'physics.plasm-ph': 'Plasma Physics',
  'physics.pop-ph': 'Popular Physics',
  'physics.soc-ph': 'Physics and Society',
  'physics.space-ph': 'Space Physics',
  'quant-ph': 'Quantum Physics',
  math: 'Mathematics',
  'math.AC': 'Commutative Algebra',
  'math.AG': 'Algebraic Geometry',
  'math.AP': 'Analysis of PDEs',
  'math.AT': 'Algebraic Topology',
  'math.CA': 'Classical Analysis and ODEs',
  'math.CO': 'Combinatorics',
  'math.CT': 'Category Theory',
  'math.CV': 'Complex Variables',
  'math.DG': 'Differential Geometry',
  'math.DS': 'Dynamical Systems',
  'math.FA': 'Functional Analysis',
  'math.GM': 'General Mathematics',
  'math.GN': 'General Topology',
  'math.GR': 'Group Theory',
  'math.GT': 'Geometric Topology',
  'math.HO': 'History and Overview',
  'math.IT': 'Information Theory',
  'math.KT': 'K-Theory and Homology',
  'math.LO': 'Logic',
  'math.MG': 'Metric Geometry',
  'math.MP': 'Mathematical Physics',
  'math.NA': 'Numerical Analysis',
  'math.NT': 'Number Theory',
  'math.OA': 'Operator Algebras',
  'math.OC': 'Optimization and Control',
  'math.PR': 'Probability',
  'math.QA': 'Quantum Algebra',
  'math.RA': 'Rings and Algebras',
  'math.RT': 'Representation Theory',
  'math.SG': 'Symplectic Geometry',
  'math.SP': 'Spectral Theory',
  'math.ST': 'Statistics Theory',
  cs: 'Computer Science',
  'cs.AI': 'Artificial Intelligence',
  'cs.AR': 'Hardware Architecture',
  'cs.CC': 'Computational Complexity',
  'cs.CE': 'Computational Engineering, Finance, and Science',
  'cs.CG': 'Computational Geometry',
  'cs.CL': 'Computation and Language',
  'cs.CR': 'Cryptography and Security',
  'cs.CV': 'Computer Vision and Pattern Recognition',
  'cs.CY': 'Computers and Society',
  'cs.DB': 'Databases',
  'cs.DC': 'Distributed, Parallel, and Cluster Computing',
  'cs.DL': 'Digital Libraries',
  'cs.DM': 'Discrete Mathematics',
  'cs.DS': 'Data Structures and Algorithms',
  'cs.ET': 'Emerging Technologies',
  'cs.FL': 'Formal Languages and Automata Theory',
  'cs.GL': 'General Literature',
  'cs.GR': 'Graphics',
  'cs.GT': 'Computer Science and Game Theory',
  'cs.HC': 'Human-Computer Interaction',
  'cs.IR': 'Information Retrieval',
  'cs.IT': 'Information Theory',
  'cs.LG': 'Machine Learning',
  'cs.LO': 'Logic in Computer Science',
  'cs.MA': 'Multiagent Systems',
  'cs.MM': 'Multimedia',
  'cs.MS': 'Mathematical Software',
  'cs.NA': 'Numerical Analysis',
  'cs.NE': 'Neural and Evolutionary Computing',
  'cs.NI': 'Networking and Internet Architecture',
  'cs.OH': 'Other Computer Science',
  'cs.OS': 'Operating Systems',
  'cs.PF': 'Performance',
  'cs.PL': 'Programming Languages',
  'cs.RO': 'Robotics',
  'cs.SC': 'Symbolic Computation',
  'cs.SD': 'Sound',
  'cs.SE': 'Software Engineering',
  'cs.SI': 'Social and Information Networks',
  'cs.SY': 'Systems and Control',
  'q-bio': 'Quantitative Biology',
  'q-bio.BM': 'Biomolecules',
  'q-bio.CB': 'Cell Behavior',
  'q-bio.GN': 'Genomics',
  'q-bio.MN': 'Molecular Networks',
  'q-bio.NC': 'Neurons and Cognition',
  'q-bio.OT': 'Other Quantitative Biology',
  'q-bio.PE': 'Populations and Evolution',
  'q-bio.QM': 'Quantitative Methods',
  'q-bio.SC': 'Subcellular Processes',
  'q-bio.TO': 'Tissues and Organs',
  'q-fin': 'Quantitative Finance',
  'q-fin.CP': 'Computational Finance',
  'q-fin.EC': 'Economics',
  'q-fin.GN': 'General Finance',
  'q-fin.MF': 'Mathematical Finance',
  'q-fin.PM': 'Portfolio Management',
  'q-fin.PR': 'Pricing of Securities',
  'q-fin.RM': 'Risk Management',
  'q-fin.ST': 'Statistical Finance',
  'q-fin.TR': 'Trading and Market Microstructure',
  stat: 'Statistics',
  'stat.AP': 'Applications',
  'stat.CO': 'Computation',
  'stat.ME': 'Methodology',
  'stat.ML': 'Machine Learning',
  'stat.OT': 'Other Statistics',
  'stat.TH': 'Statistics Theory',
  eess: 'Electrical Engineering and Systems Science',
  'eess.AS': 'Audio and Speech Processing',
  'eess.IV': 'Image and Video Processing',
  'eess.SP': 'Signal Processing',
  'eess.SY': 'Systems and Control',
  econ: 'Economics',
  'econ.EM': 'Econometrics',
  'econ.GN': 'General Economics',
  'econ.TH': 'Theoretical Economics',
};

const arxivLookup = new Map(Object.keys(ARXIV_CATEGORIES).map((c) => [c.toLowerCase(), c]));

/** Canonical arXiv category spelling ("stat.ml" → "stat.ML"), or null when unknown. */
export function arxivCategory(value: string): string | null {
  return arxivLookup.get(value.trim().toLowerCase()) ?? null;
}

function arxivCategories(value: string): string[] | null {
  const parts = value
    .trim()
    .split(/[\s+,]+/)
    .filter(Boolean);
  if (!parts.length || parts.length > 20) return null;
  const categories = parts.map(arxivCategory);
  if (categories.some((c) => !c)) return null;
  return [...new Set(categories as string[])];
}

function arxivLabel(categories: string[]): string {
  return `arXiv ${categories.join(' + ')}`;
}

// ---------------------------------------------------------------------------
// Identifier helpers

export function normalizeDoi(value: string): string | null {
  let doi = value.trim();
  try {
    doi = decodeURIComponent(doi);
  } catch {
    /* keep raw */
  }
  doi = doi
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/[.,;:)\]}>'"]+$/, '')
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) && doi.length <= 250 ? doi : null;
}

export function normalizeArxivId(value: string): string | null {
  let text = value.trim();
  const doi = normalizeDoi(text);
  if (doi?.startsWith('10.48550/arxiv.')) text = doi.slice('10.48550/arxiv.'.length);
  text = text
    .replace(/^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html|format)\//i, '')
    .replace(/^oai:arxiv\.org:/i, '')
    .replace(/^arxiv:\s*/i, '')
    .replace(/\.pdf$/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  const modern = /^(\d{4}\.\d{4,5})(?:v\d+)?$/.exec(text);
  if (modern) {
    const month = Number(modern[1].slice(2, 4));
    return month >= 1 && month <= 12 ? modern[1] : null;
  }
  const old = /^([a-z][a-z-]*)(?:\.[A-Za-z-]+)?\/(\d{7})(?:v\d+)?$/i.exec(text);
  return old ? `${old[1].toLowerCase()}/${old[2]}` : null;
}

const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref_src)$/i;

export function canonicalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return value.trim();
  }
  for (const key of [...url.searchParams.keys()])
    if (TRACKING.test(key)) url.searchParams.delete(key);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const port = url.port ? `:${url.port}` : '';
  const path = url.pathname.replace(/\/+$/, '');
  const search = url.searchParams.size ? `?${url.searchParams.toString()}` : '';
  return `${url.protocol}//${host}${port}${path}${search}`;
}

function openAlexId(value: string, prefix: 'A' | 'W'): string | null {
  const match = new RegExp(
    `^(?:https?://(?:api\\.)?openalex\\.org/(?:${prefix === 'A' ? 'authors' : 'works'}/)?)?(${prefix}\\d{4,12})/?$`,
    'i',
  ).exec(value.trim());
  return match ? match[1].toUpperCase() : null;
}

function findDoi(text: string): string | null {
  const match = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i.exec(text);
  return match ? normalizeDoi(match[1]) : null;
}

function findArxivId(text: string): string | null {
  const match =
    /arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+(?:\.[A-Za-z-]+)?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i.exec(
      text,
    ) ?? /\barXiv:\s*(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(text);
  return match ? normalizeArxivId(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Public URL checks and bounded fetches

/** Accepts only public http(s) URLs (no credentials, IP literals, localhost or internal names). */
export function publicHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Not a valid URL: ${value.slice(0, 200)}`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    !host.includes('.') ||
    isIP(host.replace(/^\[|\]$/g, '')) ||
    (url.port && url.port !== '443' && url.port !== '80') ||
    /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(host)
  )
    throw new Error('Sources must be public http(s) URLs');
  return url;
}

function headers(ctx: Pick<FetchContext, 'contactEmail'>, accept: string): Record<string, string> {
  const email = ctx.contactEmail.trim();
  return {
    'User-Agent': email ? `Atlas/0.1 (+mailto:${email})` : 'Atlas/0.1',
    Accept: accept,
  };
}

type Fetched = { status: number; url: URL; contentType: string; text: string };

async function readLimited(response: Response, limit: number, what: string): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${what} is too large`);
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const buffers: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`${what} is too large`);
    }
    buffers.push(value);
  }
  const bytes = Buffer.concat(buffers);
  const charset =
    /charset=["']?([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ??
    /^<\?xml[^>]*encoding=["']([\w-]+)/i.exec(bytes.subarray(0, 200).toString('latin1'))?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** GET with a timeout, a size cap, and redirects re-checked against the public URL rules. */
async function fetchBounded(
  input: string | URL,
  ctx: Pick<FetchContext, 'fetcher' | 'contactEmail'>,
  options: { accept: string; limit: number; what: string; allowError?: boolean },
): Promise<Fetched> {
  let url = publicHttpUrl(String(input));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await ctx.fetcher(url, {
        headers: headers(ctx, options.accept),
        signal: AbortSignal.timeout(TIMEOUT),
        redirect: 'manual',
      });
    } catch (error) {
      const name = (error as Error)?.name;
      throw new Error(
        name === 'TimeoutError' || name === 'AbortError'
          ? `${options.what} timed out (${url.host})`
          : `Could not reach ${url.host}`,
      );
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel().catch(() => {});
      url = publicHttpUrl(new URL(response.headers.get('location')!, url).href);
      continue;
    }
    if (!response.ok && !options.allowError) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${url.host} returned HTTP ${response.status}`);
    }
    return {
      status: response.status,
      url,
      contentType: (response.headers.get('content-type') ?? '').toLowerCase(),
      text: await readLimited(response, options.limit, options.what),
    };
  }
  throw new Error(`Too many redirects from ${url.host}`);
}

// ---------------------------------------------------------------------------
// Minimal XML reader (tolerant of the usual feed sloppiness)

type XmlNode = { name: string; attrs: Record<string, string>; children: (XmlNode | string)[] };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  minus: '−',
  le: '≤',
  ge: '≥',
  ne: '≠',
  asymp: '≈',
  infin: '∞',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  theta: 'θ',
  omega: 'ω',
  euro: '€',
  pound: '£',
  sect: '§',
  para: '¶',
  shy: '',
  zwj: '',
  zwnj: '',
  thinsp: ' ',
  ensp: ' ',
  emsp: ' ',
  aacute: 'á',
  agrave: 'à',
  acirc: 'â',
  auml: 'ä',
  aring: 'å',
  atilde: 'ã',
  ccedil: 'ç',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  iacute: 'í',
  igrave: 'ì',
  icirc: 'î',
  iuml: 'ï',
  ntilde: 'ñ',
  oacute: 'ó',
  ograve: 'ò',
  ocirc: 'ô',
  ouml: 'ö',
  oslash: 'ø',
  otilde: 'õ',
  uacute: 'ú',
  ugrave: 'ù',
  ucirc: 'û',
  uuml: 'ü',
  yacute: 'ý',
  szlig: 'ß',
  Aacute: 'Á',
  Auml: 'Ä',
  Aring: 'Å',
  Ccedil: 'Ç',
  Eacute: 'É',
  Ntilde: 'Ñ',
  Ouml: 'Ö',
  Oslash: 'Ø',
  Uuml: 'Ü',
};

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1));
      return Number.isFinite(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let match; (match = pattern.exec(source));)
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  return attrs;
}

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const top = () => stack[stack.length - 1];
  let index = 0;
  while (index < source.length) {
    const lt = source.indexOf('<', index);
    if (lt < 0) {
      top().children.push(decodeEntities(source.slice(index)));
      break;
    }
    if (lt > index) top().children.push(decodeEntities(source.slice(index, lt)));
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      top().children.push(source.slice(lt + 9, end < 0 ? source.length : end));
      index = end < 0 ? source.length : end + 3;
    } else if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      index = end < 0 ? source.length : end + 3;
    } else if (source[lt + 1] === '?' || source[lt + 1] === '!') {
      // Declarations, processing instructions, DOCTYPE (with a possible internal subset).
      let end = source.indexOf('>', lt);
      const bracket = source.indexOf('[', lt);
      if (source[lt + 1] === '!' && bracket >= 0 && bracket < end)
        end = source.indexOf('>', source.indexOf(']', bracket));
      index = end < 0 ? source.length : end + 1;
    } else if (source[lt + 1] === '/') {
      const end = source.indexOf('>', lt);
      const name = source
        .slice(lt + 2, end < 0 ? source.length : end)
        .trim()
        .toLowerCase();
      const open = stack.findLastIndex((node) => node.name === name);
      if (open > 0) stack.length = open;
      index = end < 0 ? source.length : end + 1;
    } else {
      // Find the end of the tag, skipping '>' inside quoted attribute values.
      let end = lt + 1;
      let quote = '';
      for (; end < source.length; end++) {
        const ch = source[end];
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
      }
      const body = source.slice(lt + 1, end);
      const match = /^([^\s/>]+)/.exec(body);
      index = end + 1;
      if (!match) {
        top().children.push('<');
        index = lt + 1;
        continue;
      }
      const node: XmlNode = {
        name: match[1].toLowerCase(),
        attrs: parseAttrs(body.slice(match[1].length).replace(/\/\s*$/, '')),
        children: [],
      };
      top().children.push(node);
      if (!/\/\s*$/.test(body)) stack.push(node);
    }
  }
  return root;
}

const nameMatches = (node: XmlNode, name: string) =>
  node.name === name || (!name.includes(':') && node.name === `atom:${name}`);

function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return (node?.children ?? []).filter(
    (child): child is XmlNode => typeof child !== 'string' && nameMatches(child, name),
  );
}

const child = (node: XmlNode | undefined, name: string) => children(node, name)[0];

/** All elements with this name, not descending into matches. */
function descendants(node: XmlNode, name: string, limit = FEED_ITEM_LIMIT): XmlNode[] {
  const found: XmlNode[] = [];
  const visit = (current: XmlNode) => {
    for (const next of current.children) {
      if (typeof next === 'string' || found.length >= limit) continue;
      if (nameMatches(next, name)) found.push(next);
      else visit(next);
    }
  };
  visit(node);
  return found;
}

function textOf(node: XmlNode | undefined): string {
  if (!node) return '';
  return node.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
}

const plain = (node: XmlNode | undefined) => clean(stripHtml(textOf(node)));
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Turns an HTML fragment (possibly still entity-escaped) into readable plain text. */
export function stripHtml(html: string, limit = ABSTRACT_LIMIT): string {
  let text = html;
  // Escaped markup ("&lt;p&gt;") is decoded once so its tags can be removed.
  if (/&lt;\/?[a-z][^&]*&gt;/i.test(text) && !/<[a-z][^>]*>/i.test(text))
    text = decodeEntities(text);
  text = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|math)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre|ul|ol|section|article)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(
      /<\/?(a|b|i|em|strong|sub|sup|span|code|small|u|s|abbr|mark|font|tt|var)\b[^>]*>/gi,
      '',
    )
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > limit * 0.8 ? cut.slice(0, space) : cut}…`;
}

function isoDate(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resolveUrl(href: string | undefined, base: string): string | null {
  if (!href?.trim()) return null;
  try {
    const url = new URL(href.trim(), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function sinceDate(since: string | null): Date {
  const date = since ? new Date(since) : null;
  return date && !Number.isNaN(date.getTime())
    ? date
    : new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000);
}

// ---------------------------------------------------------------------------
// RSS 2.0 / RSS 1.0 / Atom 1.0

export interface ParsedFeed {
  title: string;
  format: 'rss' | 'atom';
  entries: FeedEntry[];
}

export interface FeedEntry {
  title: string;
  url: string | null;
  guid: string;
  authors: string[];
  abstract: string;
  publishedAt: string | null;
  venue: string | null;
  doi: string | null;
  categories: string[];
  /** Namespaced extras used by specific sources (arxiv:announce_type, arxiv:doi, …). */
  extra: Record<string, string>;
}

function feedRoot(document: XmlNode): XmlNode | null {
  const root = document.children.find((c): c is XmlNode => typeof c !== 'string');
  if (!root) return null;
  return ['rss', 'feed', 'rdf:rdf', 'atom:feed'].includes(root.name) ? root : null;
}

/** True when the text looks like an RSS or Atom document. */
export function isFeed(text: string): boolean {
  const head = text
    .slice(0, 4000)
    .replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, '');
  return /^\s*<(rss|feed|rdf:RDF|atom:feed)[\s>]/i.test(head);
}

function authorName(node: XmlNode): string {
  const name = child(node, 'name');
  if (name) return plain(name);
  const text = plain(node);
  // RSS 2.0 <author> is "email (Name)".
  return /\(([^)]+)\)\s*$/.exec(text)?.[1].trim() ?? text.replace(/^\S+@\S+$/, '');
}

export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  const root = feedRoot(parseXml(xml));
  if (!root) throw new Error('Not an RSS or Atom feed');
  const atom = root.name.endsWith('feed');
  const channel = atom ? root : (child(root, 'channel') ?? root);
  const feedTitle = plain(child(channel, 'title'));
  const nodes = atom ? children(root, 'entry') : descendants(root, 'item');
  const entries = nodes.slice(0, FEED_ITEM_LIMIT).map((node): FeedEntry => {
    const links = children(node, 'link');
    const hrefLink =
      links.find((l) => l.attrs.href && (!l.attrs.rel || l.attrs.rel === 'alternate')) ??
      links.find((l) => l.attrs.href && l.attrs.rel !== 'self');
    const textLink = resolveUrl(textOf(links.find((l) => !l.attrs.href)).trim(), feedUrl);
    let url = atom
      ? (resolveUrl(hrefLink?.attrs.href, feedUrl) ?? textLink)
      : (textLink ?? resolveUrl(hrefLink?.attrs.href, feedUrl));
    const guidNode = child(node, 'guid') ?? child(node, 'id');
    const guid = clean(textOf(guidNode)) || node.attrs['rdf:about'] || '';
    if (!url && /^https?:\/\//i.test(guid) && guidNode?.attrs.ispermalink !== 'false')
      url = resolveUrl(guid, feedUrl);
    const authors = [
      ...children(node, 'dc:creator').map(plain),
      ...children(node, 'author').map(authorName),
    ].filter(Boolean);
    const summary = atom
      ? (child(node, 'summary') ?? child(node, 'content'))
      : (child(node, 'description') ??
        child(node, 'content:encoded') ??
        child(node, 'dc:description'));
    const extra: Record<string, string> = {};
    for (const c of node.children)
      if (typeof c !== 'string' && c.name.includes(':') && !(c.name in extra))
        extra[c.name] = clean(textOf(c));
    const doiText = [
      extra['prism:doi'],
      extra['arxiv:doi'],
      ...children(node, 'dc:identifier').map(textOf),
      url ?? '',
      guid,
    ].join(' ');
    return {
      title: plain(child(node, 'title')),
      url,
      guid,
      authors,
      abstract: stripHtml(textOf(summary)),
      publishedAt: isoDate(
        textOf(
          child(node, 'pubdate') ??
            child(node, 'published') ??
            child(node, 'dc:date') ??
            child(node, 'prism:publicationdate') ??
            child(node, 'updated'),
        ),
      ),
      venue: extra['prism:publicationname'] || feedTitle || null,
      doi: findDoi(doiText),
      categories: children(node, 'category')
        .map((c) => c.attrs.term || plain(c))
        .filter(Boolean),
      extra,
    };
  });
  return { title: feedTitle, format: atom ? 'atom' : 'rss', entries };
}

function isGithubReleases(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.replace(/^www\./, '') === 'github.com' &&
      /^\/[^/]+\/[^/]+\/releases\.atom$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function entryToItem(entry: FeedEntry, feedUrl: string): RawNewsItem | null {
  const text = `${entry.url ?? ''} ${entry.guid}`;
  const arxivId = findArxivId(text);
  const doi = entry.doi ?? findDoi(entry.abstract.slice(0, 600));
  const url =
    entry.url ??
    (arxivId ? `https://arxiv.org/abs/${arxivId}` : doi ? `https://doi.org/${doi}` : null);
  if (!entry.title || !url) return null;
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* ignore */
  }
  const kind: NewsItemKind = isGithubReleases(feedUrl)
    ? 'release'
    : arxivId || entry.doi || host === 'arxiv.org' || host === 'doi.org'
      ? 'paper'
      : 'post';
  return {
    kind,
    title: entry.title.slice(0, 500),
    authors: entry.authors.slice(0, 100),
    abstract: entry.abstract,
    url,
    venue: entry.venue,
    publishedAt: entry.publishedAt,
    doi,
    arxivId,
    openAlexId: null,
    referencedWorks: [],
  };
}

async function fetchFeed(value: string, ctx: FetchContext): Promise<RawNewsItem[]> {
  const response = await fetchBounded(value, ctx, {
    accept: FEED_ACCEPT,
    limit: FEED_LIMIT,
    what: 'Feed',
  });
  if (!isFeed(response.text))
    throw new Error(`${response.url.host} did not return an RSS or Atom feed`);
  const feed = parseFeed(response.text, response.url.href);
  const since = sinceDate(ctx.since).getTime();
  return feed.entries
    .map((entry) => entryToItem(entry, value))
    .filter((item): item is RawNewsItem => !!item)
    .filter((item) => !item.publishedAt || new Date(item.publishedAt).getTime() >= since);
}

// ---------------------------------------------------------------------------
// arXiv announcements (rss.arxiv.org)

function splitArxivAuthors(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(/,\s*|\s+and\s+/))
    .map((name) => name.trim())
    .filter(Boolean);
}

async function fetchArxiv(value: string, ctx: FetchContext): Promise<RawNewsItem[]> {
  const categories = arxivCategories(value);
  if (!categories) throw new Error(`Unknown arXiv category: ${value}`);
  const response = await fetchBounded(`https://rss.arxiv.org/rss/${categories.join('+')}`, ctx, {
    accept: FEED_ACCEPT,
    limit: FEED_LIMIT,
    what: 'arXiv feed',
  });
  if (!isFeed(response.text)) throw new Error('arXiv did not return an RSS feed');
  const feed = parseFeed(response.text, response.url.href);
  const seen = new Set<string>();
  const items: RawNewsItem[] = [];
  for (const entry of feed.entries) {
    const announce = (entry.extra['arxiv:announce_type'] ?? '').toLowerCase();
    if (announce.startsWith('replace')) continue;
    const arxivId = normalizeArxivId(entry.guid) ?? findArxivId(entry.url ?? '');
    if (!arxivId || seen.has(arxivId) || !entry.title) continue;
    seen.add(arxivId);
    const abstract = entry.abstract
      .replace(/^arXiv:\S+\s+Announce Type:\s*\S+\s*/i, '')
      .replace(/^Abstract:\s*/i, '')
      .trim();
    items.push({
      kind: 'paper',
      title: entry.title.slice(0, 500),
      authors: splitArxivAuthors(entry.authors).slice(0, 100),
      abstract,
      url: `https://arxiv.org/abs/${arxivId}`,
      venue: 'arXiv',
      publishedAt: entry.publishedAt,
      doi: normalizeDoi(entry.extra['arxiv:doi'] ?? '') ?? null,
      arxivId,
      openAlexId: null,
      referencedWorks: [],
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// OpenAlex

export function openAlexParams(
  url: URL,
  ctx: Pick<FetchContext, 'contactEmail' | 'openAlexKey'>,
): URL {
  if (ctx.openAlexKey?.trim()) url.searchParams.set('api_key', ctx.openAlexKey.trim());
  if (ctx.contactEmail.trim()) url.searchParams.set('mailto', ctx.contactEmail.trim());
  return url;
}

async function openAlexJson(
  url: URL,
  ctx: Pick<FetchContext, 'fetcher' | 'contactEmail' | 'openAlexKey'>,
): Promise<any> {
  const response = await fetchBounded(openAlexParams(url, ctx), ctx, {
    accept: 'application/json',
    limit: JSON_LIMIT,
    what: 'OpenAlex response',
    allowError: true,
  });
  let payload: any = null;
  try {
    payload = JSON.parse(response.text);
  } catch {
    /* handled below */
  }
  if (response.status >= 400) {
    const detail = typeof payload?.message === 'string' ? payload.message : '';
    if (!ctx.openAlexKey?.trim() && [401, 403, 429].includes(response.status))
      throw new Error(OPENALEX_KEY_MESSAGE);
    throw new Error(
      `OpenAlex returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
    );
  }
  if (!payload || typeof payload !== 'object') throw new Error('Invalid OpenAlex response');
  return payload;
}

/** Rebuilds plain text from OpenAlex's abstract_inverted_index. */
export function invertedAbstract(index: unknown): string {
  if (!index || typeof index !== 'object') return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index as Record<string, unknown>))
    if (Array.isArray(positions))
      for (const position of positions)
        if (Number.isInteger(position) && position >= 0 && position < 20000) words[position] = word;
  return stripHtml(words.filter((w) => w !== undefined).join(' '));
}

const shortOpenAlexId = (value: unknown) =>
  typeof value === 'string' ? (/([AWSI]\d+)$/i.exec(value)?.[1].toUpperCase() ?? null) : null;

export function openAlexWorkToItem(work: any): RawNewsItem | null {
  const title = stripHtml(String(work?.display_name ?? work?.title ?? ''), 500).replace(
    /\s+/g,
    ' ',
  );
  if (!title) return null;
  const doi = normalizeDoi(String(work.ids?.doi ?? work.doi ?? ''));
  const locations: any[] = [
    work.primary_location,
    ...(Array.isArray(work.locations) ? work.locations : []),
  ].filter(Boolean);
  let arxivId: string | null = doi?.startsWith('10.48550/arxiv.') ? normalizeArxivId(doi) : null;
  for (const location of locations) {
    if (arxivId) break;
    for (const candidate of [location.landing_page_url, location.pdf_url, location.id])
      if (typeof candidate === 'string' && /arxiv/i.test(candidate)) {
        arxivId = findArxivId(candidate) ?? normalizeArxivId(candidate.replace(/^pmh:/, ''));
        if (arxivId) break;
      }
  }
  if (!arxivId && typeof work.ids?.arxiv === 'string') arxivId = normalizeArxivId(work.ids.arxiv);
  const landing = locations
    .map((l) => l.landing_page_url)
    .find((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
  const openAlexId = shortOpenAlexId(work.id);
  const url =
    landing ??
    (doi ? `https://doi.org/${doi}` : openAlexId ? `https://openalex.org/${openAlexId}` : null);
  if (!url) return null;
  const type = String(work.type ?? '');
  return {
    kind: type === 'dataset' ? 'dataset' : 'paper',
    title,
    authors: (Array.isArray(work.authorships) ? work.authorships : [])
      .map((a: any) => String(a?.author?.display_name ?? a?.raw_author_name ?? '').trim())
      .filter(Boolean)
      .slice(0, 100),
    abstract: invertedAbstract(work.abstract_inverted_index),
    url,
    venue:
      typeof work.primary_location?.source?.display_name === 'string'
        ? work.primary_location.source.display_name
        : null,
    publishedAt: isoDate(work.publication_date),
    doi,
    arxivId,
    openAlexId,
    referencedWorks: (Array.isArray(work.referenced_works) ? work.referenced_works : [])
      .map(shortOpenAlexId)
      .filter((id: string | null): id is string => !!id && id.startsWith('W'))
      .slice(0, 2000),
  };
}

const WORK_FIELDS =
  'id,doi,title,display_name,publication_date,ids,type,primary_location,locations,authorships,abstract_inverted_index,referenced_works';

/** Strip characters that carry meaning in OpenAlex filter syntax. */
const filterText = (value: string) =>
  value
    .replace(/[,|:!<>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function fetchOpenAlex(
  kind: 'openalex_author' | 'openalex_cites' | 'openalex_query',
  value: string,
  ctx: FetchContext,
): Promise<RawNewsItem[]> {
  const filters: string[] = [];
  if (kind === 'openalex_author') {
    const id = openAlexId(value, 'A');
    if (!id) throw new Error(`Not an OpenAlex author ID: ${value}`);
    filters.push(`authorships.author.id:${id}`);
  } else if (kind === 'openalex_cites') {
    const id = openAlexId(value, 'W');
    if (!id) throw new Error(`Not an OpenAlex work ID: ${value}`);
    filters.push(`cites:${id}`);
  } else {
    const query = filterText(value);
    if (!query) throw new Error('Empty OpenAlex query');
    filters.push(`title_and_abstract.search:${query}`);
  }
  // from_created_date needs a paid OpenAlex plan, so the window uses publication dates.
  // Future-dated works (issue dates) are capped so they cannot crowd out the current window.
  filters.push(
    `from_publication_date:${sinceDate(ctx.since).toISOString().slice(0, 10)}`,
    `to_publication_date:${new Date().toISOString().slice(0, 10)}`,
  );
  const url = new URL(`${OPENALEX}/works`);
  url.searchParams.set('filter', filters.join(','));
  url.searchParams.set('sort', 'publication_date:desc');
  url.searchParams.set('per-page', '50');
  url.searchParams.set('select', WORK_FIELDS);
  const payload = await openAlexJson(url, ctx);
  if (!Array.isArray(payload.results)) throw new Error('Invalid OpenAlex response');
  return payload.results
    .map(openAlexWorkToItem)
    .filter((item: RawNewsItem | null): item is RawNewsItem => !!item);
}

// ---------------------------------------------------------------------------
// Public API

export async function fetchSource(
  source: Pick<NewsSource, 'kind' | 'value'>,
  ctx: FetchContext,
): Promise<RawNewsItem[]> {
  switch (source.kind) {
    case 'arxiv':
      return fetchArxiv(source.value, ctx);
    case 'rss':
      return fetchFeed(source.value, ctx);
    case 'openalex_author':
    case 'openalex_cites':
    case 'openalex_query':
      return fetchOpenAlex(source.kind, source.value, ctx);
    default:
      throw new Error(`Unknown source kind: ${String((source as { kind: unknown }).kind)}`);
  }
}

const SOURCE_KINDS: NewsSourceKind[] = [
  'arxiv',
  'rss',
  'openalex_author',
  'openalex_query',
  'openalex_cites',
];

function arxivListCategories(url: URL): string[] | null {
  const host = url.hostname.replace(/^(www|export)\./, '');
  const path = decodeURIComponent(url.pathname);
  const match =
    host === 'arxiv.org'
      ? /^\/(?:list|rss|archive)\/([^/]+)/.exec(path)
      : host === 'rss.arxiv.org'
        ? /^\/(?:rss|atom)\/([^/]+)/.exec(path)
        : null;
  return match ? arxivCategories(match[1]) : null;
}

function feedLabel(url: URL): string {
  return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`.slice(0, 120);
}

export function validateSourceInput(input: NewsSourceInput): NewsSourceInput {
  if (!input || !SOURCE_KINDS.includes(input.kind)) throw new Error('Unknown source kind');
  if (typeof input.value !== 'string' || !input.value.trim() || input.value.length > 2000)
    throw new Error('Source value is required');
  const raw = input.value.trim();
  const label = typeof input.label === 'string' ? clean(input.label).slice(0, 120) : '';
  let value: string;
  let fallback: string;
  switch (input.kind) {
    case 'arxiv': {
      let categories = arxivCategories(raw);
      if (!categories && /^https?:\/\//i.test(raw))
        try {
          categories = arxivListCategories(new URL(raw));
        } catch {
          /* invalid URL */
        }
      if (!categories) throw new Error(`Unknown arXiv category: ${raw.slice(0, 100)}`);
      value = categories.join('+');
      fallback = arxivLabel(categories);
      break;
    }
    case 'rss': {
      const url = publicHttpUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      url.hash = '';
      value = url.href;
      fallback = feedLabel(url);
      break;
    }
    case 'openalex_author':
    case 'openalex_cites': {
      const id = openAlexId(raw, input.kind === 'openalex_author' ? 'A' : 'W');
      if (!id)
        throw new Error(
          input.kind === 'openalex_author'
            ? 'Use an OpenAlex author ID like A5023888391'
            : 'Use an OpenAlex work ID like W2741809807',
        );
      value = id;
      fallback = input.kind === 'openalex_author' ? `Author ${id}` : `Citing ${id}`;
      break;
    }
    case 'openalex_query': {
      value = clean(raw);
      if (value.length > 200) throw new Error('Keep keyword queries under 200 characters');
      fallback = value;
      break;
    }
  }
  return { kind: input.kind, value, label: label || fallback };
}

function suggestion(
  kind: NewsSourceKind,
  value: string,
  label: string,
  reason: string,
): NewsSourceSuggestion {
  return { id: null, kind, value, label, reason, origin: 'detected', createdAt: null };
}

async function openAlexLabel(
  kind: 'A' | 'W',
  id: string,
  ctx: Omit<FetchContext, 'since'>,
): Promise<string | null> {
  try {
    const url = new URL(`${OPENALEX}/${kind === 'A' ? 'authors' : 'works'}/${id}`);
    url.searchParams.set('select', 'id,display_name');
    const payload = await openAlexJson(url, ctx);
    return typeof payload.display_name === 'string'
      ? clean(stripHtml(payload.display_name, 200))
      : null;
  } catch {
    return null;
  }
}

async function openAlexWorkSuggestion(
  lookup: string,
  ctx: Omit<FetchContext, 'since'>,
): Promise<NewsSourceSuggestion[]> {
  const url = new URL(`${OPENALEX}/works/${lookup}`);
  url.searchParams.set('select', 'id,display_name');
  const payload = await openAlexJson(url, ctx);
  const id = shortOpenAlexId(payload.id);
  if (!id) return [];
  const title = clean(stripHtml(String(payload.display_name ?? id), 200));
  return [
    suggestion(
      'openalex_cites',
      id,
      `Citing: ${title}`.slice(0, 120),
      `New works citing “${title}”`,
    ),
  ];
}

const institution = (author: any): string | null =>
  author?.last_known_institutions?.[0]?.display_name ??
  author?.affiliations?.[0]?.institution?.display_name ??
  null;

function looksLikeName(text: string): boolean {
  const tokens = text.split(/\s+/);
  return (
    tokens.length >= 2 &&
    tokens.length <= 4 &&
    tokens.every((t) => /^(\p{Lu}[\p{L}'’-]*\.?|\p{Lu}\.(\p{Lu}\.)*)$/u.test(t))
  );
}

async function discoverFeeds(
  url: URL,
  ctx: Omit<FetchContext, 'since'>,
): Promise<NewsSourceSuggestion[]> {
  const page = await fetchBounded(url, ctx, {
    accept: FEED_ACCEPT,
    limit: FEED_LIMIT,
    what: 'Page',
  });
  if (isFeed(page.text)) {
    const feed = parseFeed(page.text, page.url.href);
    const kindNote = isGithubReleases(page.url.href)
      ? 'GitHub releases'
      : `${feed.format.toUpperCase()} feed`;
    return [
      suggestion(
        'rss',
        page.url.href,
        (feed.title || feedLabel(page.url)).slice(0, 120),
        `${kindNote} with ${feed.entries.length} recent entries`,
      ),
    ];
  }
  const found: NewsSourceSuggestion[] = [];
  const seen = new Set<string>();
  const pageTitle = clean(
    stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.text)?.[1] ?? '', 120),
  );
  for (const match of page.text.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttrs(match[0].slice(5).replace(/\/?>$/, ''));
    if (
      !/(^|\s)alternate(\s|$)/i.test(attrs.rel ?? '') ||
      !/application\/(rss|atom)\+xml/i.test(attrs.type ?? '')
    )
      continue;
    const href = resolveUrl(attrs.href, page.url.href);
    if (!href || seen.has(href)) continue;
    try {
      publicHttpUrl(href);
    } catch {
      continue;
    }
    seen.add(href);
    const format = /atom/i.test(attrs.type) ? 'Atom' : 'RSS';
    found.push(
      suggestion(
        'rss',
        href,
        (clean(attrs.title ?? '') || pageTitle || feedLabel(new URL(href))).slice(0, 120),
        `${format} feed advertised by ${page.url.hostname.replace(/^www\./, '')}`,
      ),
    );
    if (found.length >= 5) break;
  }
  if (found.length) return found;
  // No autodiscovery: probe a few conventional feed locations.
  for (const path of ['/feed', '/rss.xml', '/atom.xml', '/index.xml', '/feed.xml']) {
    const candidate = new URL(path, page.url.origin);
    try {
      const probe = await fetchBounded(candidate, ctx, {
        accept: FEED_ACCEPT,
        limit: FEED_LIMIT,
        what: 'Feed',
      });
      if (!isFeed(probe.text)) continue;
      const feed = parseFeed(probe.text, probe.url.href);
      return [
        suggestion(
          'rss',
          probe.url.href,
          (feed.title || pageTitle || feedLabel(probe.url)).slice(0, 120),
          `${feed.format.toUpperCase()} feed found at ${probe.url.pathname}`,
        ),
      ];
    } catch {
      /* try the next location */
    }
  }
  throw new Error(`No RSS or Atom feed found at ${page.url.hostname}`);
}

export async function detectSources(
  input: string,
  ctx: Omit<FetchContext, 'since'>,
): Promise<NewsSourceSuggestion[]> {
  const text = clean(String(input ?? ''));
  if (!text) throw new Error('Enter a category, URL, author, or keywords');
  if (text.length > 500) throw new Error('Keep the source under 500 characters');

  // arXiv categories: "stat.ML", "stat.ML+cs.LG", "math".
  const categories = /^[a-z-]+(\.[a-z-]+)?([\s+,]+[a-z-]+(\.[a-z-]+)?)*$/i.test(text)
    ? arxivCategories(text)
    : null;
  if (categories) {
    const names = categories.map((c) => `${c} (${ARXIV_CATEGORIES[c]})`).join(', ');
    const result = [
      suggestion(
        'arxiv',
        categories.join('+'),
        arxivLabel(categories),
        `New arXiv announcements in ${names}`,
      ),
    ];
    if (categories.length === 1 && !categories[0].includes('.'))
      result.push(suggestion('openalex_query', text, text, `New works mentioning “${text}”`));
    return result;
  }

  // Bare identifiers.
  const author = openAlexId(text, 'A');
  if (author) {
    const name = await openAlexLabel('A', author, ctx);
    return [
      suggestion(
        'openalex_author',
        author,
        name ?? `Author ${author}`,
        `New works by ${name ?? author}`,
      ),
    ];
  }
  const work = openAlexId(text, 'W');
  if (work) {
    const title = await openAlexLabel('W', work, ctx);
    return [
      suggestion(
        'openalex_cites',
        work,
        title ? `Citing: ${title}`.slice(0, 120) : `Citing ${work}`,
        `New works citing “${title ?? work}”`,
      ),
    ];
  }
  // A paper (DOI or arXiv id/abs URL) → follow the works citing it.
  const doi = normalizeDoi(text);
  if (doi) return openAlexWorkSuggestion(`doi:${doi}`, ctx);
  const arxivId = normalizeArxivId(text);
  if (arxivId) return openAlexWorkSuggestion(`doi:10.48550/arxiv.${arxivId}`, ctx);

  // URLs (with or without scheme).
  const urlLike = /^https?:\/\//i.test(text)
    ? text
    : /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(text) && !/\s/.test(text)
      ? `https://${text}`
      : null;
  if (urlLike) {
    const url = publicHttpUrl(urlLike);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const listed = arxivListCategories(url);
    if (listed)
      return [
        suggestion(
          'arxiv',
          listed.join('+'),
          arxivLabel(listed),
          `New arXiv announcements in ${listed.join(', ')}`,
        ),
      ];
    if (host === 'github.com') {
      const [owner, repo] = url.pathname.split('/').filter(Boolean);
      if (owner && repo) {
        const name = `${owner}/${repo.replace(/\.git$/, '')}`;
        return [
          suggestion(
            'rss',
            `https://github.com/${name}/releases.atom`,
            `${name} releases`,
            `New GitHub releases of ${name}`,
          ),
        ];
      }
    }
    if (host === 'openalex.org' || host === 'api.openalex.org') {
      const id = /\/(?:authors\/|works\/)?([AW]\d{4,12})\/?$/i.exec(url.pathname)?.[1];
      if (id) return detectSources(id, ctx);
    }
    if (host === 'doi.org' || host === 'dx.doi.org') {
      const linked = normalizeDoi(url.href);
      if (linked) return openAlexWorkSuggestion(`doi:${linked}`, ctx);
    }
    return discoverFeeds(url, ctx);
  }

  // Plain words → keyword query, plus author matches when it looks like a name.
  const query = text.slice(0, 200);
  const result = [suggestion('openalex_query', query, query, `New works mentioning “${query}”`)];
  if (looksLikeName(query)) {
    try {
      const url = new URL(`${OPENALEX}/authors`);
      url.searchParams.set('search', query);
      url.searchParams.set('per-page', '3');
      url.searchParams.set(
        'select',
        'id,display_name,works_count,last_known_institutions,affiliations',
      );
      const payload = await openAlexJson(url, ctx);
      for (const author of Array.isArray(payload.results) ? payload.results.slice(0, 3) : []) {
        const id = shortOpenAlexId(author.id);
        if (!id || typeof author.display_name !== 'string') continue;
        const place = institution(author);
        result.push(
          suggestion(
            'openalex_author',
            id,
            author.display_name.slice(0, 120),
            [place, `${Number(author.works_count) || 0} works`].filter(Boolean).join(' · '),
          ),
        );
      }
    } catch {
      /* the keyword suggestion still stands */
    }
  }
  return result;
}
