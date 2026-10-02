/** A shorter query, or a shorter word still being typed, matches too much to search. */
export const MESSAGE_SEARCH_MIN_CHARS = 4;
/** A query of more searchable words than this is cut to its first ones. */
export const MESSAGE_SEARCH_MAX_TERMS = 8;

/**
 * Common English words that are in almost every message, so a search for one
 * reads the whole history for nothing. They are never searched, as whole
 * words or as prefixes. The pieces a split leaves of a contraction ("don't"
 * is "don" and "t") are here too.
 */
export const MESSAGE_SEARCH_FILLER_WORDS: readonly string[] = [
  // Articles and determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'some', 'any', 'each', 'every', 'all',
  'both', 'either', 'neither', 'much', 'many', 'more', 'most', 'such', 'other', 'another',
  'own', 'same', 'no', 'not', 'only', 'very',
  // Pronouns
  'i', 'me', 'my', 'mine', 'myself', 'you', 'your', 'yours', 'yourself', 'he', 'him', 'his',
  'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'we', 'us', 'our', 'ours',
  'ourselves', 'they', 'them', 'their', 'theirs', 'themselves', 'who', 'whom', 'whose', 'which',
  'what', 'someone', 'something', 'anyone', 'anything', 'everyone', 'everything',
  // Auxiliaries
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do',
  'does', 'did', 'doing', 'done', 'will', 'would', 'shall', 'should', 'can', 'could', 'might',
  'must', 'get', 'gets', 'got',
  // Contraction pieces
  's', 't', 'd', 'll', 'm', 're', 've', 'don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'weren',
  'haven', 'hasn', 'hadn', 'won', 'wouldn', 'couldn', 'shouldn', 'cannot',
  // Conjunctions
  'and', 'or', 'but', 'nor', 'so', 'yet', 'if', 'then', 'than', 'because', 'as', 'while',
  'though', 'although', 'unless', 'until', 'whether', 'also',
  // Prepositions
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'about', 'above',
  'below', 'over', 'under', 'after', 'before', 'between', 'through', 'during', 'without',
  'within', 'again', 'against', 'upon', 'via', 'per', 'around',
  // Adverbs
  'here', 'there', 'where', 'when', 'why', 'how', 'now', 'just', 'too', 'still', 'even', 'ever',
  'never', 'always', 'really', 'maybe', 'already', 'soon',
  // Chat filler
  'ok', 'okay', 'yes', 'yeah', 'yep', 'yup', 'nope', 'hi', 'hey', 'hello', 'thanks', 'thank',
  'thx', 'please', 'pls', 'like', 'gonna', 'wanna', 'kinda', 'lol', 'oh', 'ah', 'um', 'uh', 'hmm',
  'oops', 'anyway',
];

const FILLER_WORDS = new Set(MESSAGE_SEARCH_FILLER_WORDS);

/**
 * The Postgres `simple` tsquery for a typed message search, ANDed. Earlier
 * words are complete and match whole words; the last word is still being
 * typed, so it matches as a prefix ("android bui" finds "Android build"),
 * and only once it has MESSAGE_SEARCH_MIN_CHARS characters. Filler words are
 * dropped. Null when no searchable word remains.
 */
export function messageSearchTerms(query: string): string | null {
  const words = query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const partial = words.pop();
  const terms = words.filter((word) => !FILLER_WORDS.has(word)).map((word) => `'${word}'`);
  if (partial && partial.length >= MESSAGE_SEARCH_MIN_CHARS && !FILLER_WORDS.has(partial))
    terms.push(`'${partial}':*`);
  return terms.length ? terms.slice(0, MESSAGE_SEARCH_MAX_TERMS).join(' & ') : null;
}
