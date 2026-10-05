/*
 * Pure text logic shared by the page reader (content.js), the side panel
 * (panel.js) and the Node tests. No DOM or chrome.* access in this file.
 */
(function (root) {
  'use strict';

  // ---------- emails ----------

  const FREE_MAIL = new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'ymail.com',
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
    'rediffmail.com', 'protonmail.com', 'proton.me', 'aol.com', 'zoho.com', 'zohomail.in',
    'mail.com', 'gmx.com'
  ]);
  const NOT_TLD = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'js', 'css']);
  const EMAIL_RE = /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

  // "name [at] company [dot] com" -> "name@company.com"
  function deobfuscate(text) {
    return String(text || '')
      .replace(/\s*[\[({]\s*at\s*[\])}]\s*/gi, '@')
      .replace(/\s*[\[({]\s*dot\s*[\])}]\s*/gi, '.');
  }

  function findEmails(text) {
    const out = [];
    const seen = new Set();
    const matches = deobfuscate(text).match(EMAIL_RE) || [];
    for (let m of matches) {
      m = m.replace(/[.\-]+$/, '').toLowerCase();
      const tld = m.slice(m.lastIndexOf('.') + 1);
      if (NOT_TLD.has(tld) || seen.has(m)) continue;
      seen.add(m);
      out.push(m);
    }
    return out;
  }

  function companyFromEmail(email) {
    const domain = String(email || '').split('@')[1] || '';
    if (!domain || FREE_MAIL.has(domain)) return '';
    const parts = domain.split('.');
    let i = parts.length - 2;
    // acme.co.in, acme.com.au -> "acme"
    if (parts.length >= 3 && parts[parts.length - 1].length === 2 &&
        ['co', 'com', 'org', 'net', 'ac', 'gov'].includes(parts[i])) i -= 1;
    const label = parts[Math.max(i, 0)] || '';
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : '';
  }

  // ---------- names and companies ----------

  function cleanName(raw) {
    if (!raw) return '';
    let s = String(raw).split('\n').map(t => t.trim()).filter(Boolean)[0] || '';
    s = s
      .replace(/^View:?\s+/i, '')
      .replace(/[’']s\s+(profile|graphic link|open to work).*$/i, '')
      .replace(/\s*[•·|].*$/, '')
      .replace(/\s*\((he|she|they)[^)]*\)/i, '')
      .replace(/,?\s+(verified|premium)\b.*$/i, '')
      .trim();
    // LinkedIn often repeats the name for screen readers: "John DoeJohn Doe"
    const half = s.length / 2;
    if (s.length > 3 && s.length % 2 === 0 && s.slice(0, half) === s.slice(half)) s = s.slice(0, half);
    return s.trim();
  }

  function tidyCompany(s) {
    return String(s || '')
      .replace(/\s+(?:-|–|—)\s+.*$/, '')
      .replace(/[,;:!].*$/, '')
      .replace(/\s+(is|are|for|and|to|in|as|who|we)\s.*$/i, '')
      .replace(/[.\s]+$/, '')
      .trim()
      .slice(0, 60);
  }

  const NOT_COMPANY = new Set(['we', 'our', 'my', 'the', 'this', 'it', 'he', 'she', 'who',
    'team', 'company', 'client', 'us', 'everyone', 'linkedin']);

  const CAP = "[A-Z][A-Za-z0-9&.'-]*";
  const COMPANY_PATTERNS = [
    new RegExp('(?:hiring at|join us at|join our team at|openings? (?:at|with)|positions? (?:at|with)|' +
      'opportunit(?:y|ies) (?:at|with)|team at|working at)\\s+(' + CAP + '(?: ' + CAP + '){0,3})'),
    new RegExp('Company(?: Name)?\\s*[:\\-]\\s*(' + CAP + '(?: ' + CAP + '){0,3})'),
    new RegExp('\\b(' + CAP + '(?: ' + CAP + '){0,3}) is (?:hiring|looking for|expanding)')
  ];

  /**
   * Best guess at the company behind a post.
   * Order: poster's headline ("Recruiter at Acme") -> company email domain -> wording in the post.
   */
  function guessCompany(headline, text, email) {
    const h = String(headline || '');
    const m = h.match(/(?:\bat\b|@)\s*([^|•·\n]+)/i);
    if (m) {
      const c = tidyCompany(m[1]);
      if (c && !NOT_COMPANY.has(c.toLowerCase())) return c;
    }
    const fromMail = companyFromEmail(email);
    if (fromMail) return fromMail;
    for (const re of COMPANY_PATTERNS) {
      const t = String(text || '').match(re);
      if (t) {
        const c = tidyCompany(t[1]);
        if (c && !NOT_COMPANY.has(c.toLowerCase())) return c;
      }
    }
    return '';
  }

  const HIRING_RE = new RegExp(
    "\\b(hiring|we'?re looking|looking for|openings?|vacanc(?:y|ies)|job opportunit|" +
    "(?:send|share|mail|email|drop)\\s+(?:me\\s+)?(?:your|ur)?\\s*(?:updated\\s+)?(?:resume|cv|profile)|" +
    "walk-?in|immediate joiner|recruit|apply now|interested candidates)", 'i');

  function looksLikeHiring(text) {
    return HIRING_RE.test(String(text || ''));
  }

  // A job seeker's own post ("I am looking for a job, reach me at ...") also has an email in it.
  const SEEKER_RE = new RegExp(
    "#opentowork|\\bopen to work\\b|" +
    "\\bi(?:'| a)?m (?:currently |actively |also )?(?:looking|seeking|searching|exploring)\\b" +
      "(?! to hire| for (?:an? )?(?:candidates?|people|someone|developers?|engineers?|interns?|freshers?|[a-z.+#]+ (?:developers?|engineers?|designers?|analysts?)))|" +
    "\\bi am an? immediate joiner\\b|" +
    "\\blooking for (?:an? )?(?:job|new job|job change|job opportunit|career opportunit|new opportunit|new role|switch)|" +
    "\\bseeking (?:an? )?(?:new |better |full[- ]time )?(?:job|opportunit|role|position)|" +
    "\\b(?:kindly|please|pls) (?:refer|consider) me\\b|\\bany (?:leads?|referrals?|openings?) (?:would|will) be\\b|" +
    "\\b(?:i was|i got|got|been) laid off\\b|\\bimpacted by (?:the )?(?:recent )?layoffs?\\b|" +
    "\\bmy (?:resume|cv) is attached\\b|\\bplease find my (?:resume|cv)\\b", 'i');
  const SEEKER_HEADLINE = /open to work|seeking (?:new )?opportunit|looking for (?:an? )?(?:job|opportunit|new|change)|actively (?:looking|seeking)|job seeker|immediate joiner/i;
  const RECRUITER_RE = /\b(?:we(?:'| a)?re (?:hiring|looking)|hiring for|is hiring|(?:send|share|mail|email|drop|forward)\s+(?:me\s+|us\s+)?(?:your|ur)\b|interested candidates|job description|\bjd\b|walk-?in|apply now|our client)/i;

  /** True when a post reads like someone asking for a job, not offering one. */
  function looksLikeJobSeeker(text, headline) {
    const t = String(text || '');
    if (RECRUITER_RE.test(t)) return false;
    return SEEKER_RE.test(t) || SEEKER_HEADLINE.test(String(headline || ''));
  }

  // ---------- resume keywords ----------

  // [canonical, ...aliases]. Broad on purpose: tech and non-tech roles.
  const SKILLS = [
    ['javascript', 'js'], ['typescript', 'ts'], ['python'], ['java'], ['c++', 'cpp'], ['c#', 'c sharp'],
    ['.net', 'dotnet', 'asp.net'], ['go', 'golang'], ['rust'], ['ruby'], ['php'], ['kotlin'], ['swift'],
    ['scala'], ['sql'], ['html'], ['css'], ['react', 'reactjs', 'react.js'], ['react native'],
    ['angular', 'angularjs'], ['vue', 'vuejs', 'vue.js'], ['next.js', 'nextjs'],
    ['node.js', 'nodejs', 'node js', 'node'], ['express', 'expressjs'], ['nestjs', 'nest.js'],
    ['django'], ['flask'], ['fastapi'], ['spring boot', 'springboot'], ['spring'], ['hibernate'],
    ['laravel'], ['rails', 'ruby on rails'], ['flutter'], ['android'], ['ios'], ['redux'],
    ['tailwind', 'tailwindcss'], ['bootstrap'], ['jquery'], ['graphql'], ['rest api', 'restful', 'rest apis'],
    ['microservices'], ['mongodb', 'mongo'], ['mysql'], ['postgresql', 'postgres'], ['oracle'],
    ['sql server', 'mssql'], ['redis'], ['elasticsearch'], ['kafka'], ['rabbitmq'], ['aws'], ['azure'],
    ['gcp', 'google cloud'], ['docker'], ['kubernetes', 'k8s'], ['terraform'], ['ansible'], ['jenkins'],
    ['ci/cd', 'cicd'], ['git'], ['linux'], ['devops'], ['sre'], ['selenium'], ['cypress'], ['playwright'],
    ['jest'], ['junit'], ['manual testing'], ['automation testing', 'test automation'], ['qa', 'quality assurance'],
    ['machine learning', 'ml'], ['deep learning'], ['nlp', 'natural language processing'],
    ['generative ai', 'genai', 'gen ai', 'gen. ai'], ['llm', 'llms', 'large language model', 'large language models'],
    ['artificial intelligence', 'ai'], ['rag', 'retrieval augmented generation'], ['langchain'], ['langgraph'],
    ['llamaindex', 'llama index'], ['openai', 'azure openai', 'gpt'], ['hugging face', 'huggingface'],
    ['prompt engineering'], ['agentic ai', 'ai agents', 'ai agent'], ['vector database', 'vector db', 'pinecone', 'faiss', 'chromadb'],
    ['fine-tuning', 'fine tuning', 'finetuning'], ['mlops'], ['computer vision', 'opencv'], ['transformers'], ['bedrock'],
    ['streamlit'], ['firebase'], ['supabase'], ['dynamodb'], ['bigquery'], ['redshift'], ['dbt'], ['github actions'],
    ['system design'], ['data structures', 'dsa'], ['agile', 'scrum'], ['jira'], ['svelte'], ['webpack'], ['vite'],
    ['material ui', 'mui'], ['prisma'], ['grpc'], ['websocket', 'websockets'], ['oauth'], ['nginx'],
    ['ai engineer'], ['ml engineer'], ['machine learning engineer'], ['genai engineer', 'gen ai engineer', 'generative ai engineer'],
    ['prompt engineer'],
    ['pytorch'], ['tensorflow'], ['pandas'], ['numpy'], ['scikit-learn', 'sklearn'], ['data science'],
    ['data analysis', 'data analytics'], ['data engineering'], ['etl'], ['spark', 'pyspark'], ['hadoop'],
    ['airflow'], ['snowflake'], ['databricks'], ['power bi', 'powerbi'], ['tableau'], ['excel', 'ms excel'],
    ['sap'], ['salesforce'], ['servicenow'], ['figma'], ['ui/ux', 'ux', 'ui design'], ['photoshop'],
    ['embedded'], ['cybersecurity', 'cyber security'], ['networking'], ['blockchain'],
    // roles
    ['software engineer', 'software developer', 'sde'], ['frontend', 'front end', 'front-end'],
    ['backend', 'back end', 'back-end'], ['full stack', 'fullstack', 'full-stack'],
    ['mern'], ['mean'], ['data analyst'], ['data scientist'], ['data engineer'], ['business analyst'],
    ['product manager'], ['project manager'], ['scrum master'], ['devops engineer'], ['qa engineer', 'test engineer'],
    ['web developer'], ['mobile developer'], ['intern', 'internship'], ['fresher', 'freshers'],
    // non-tech
    ['teller', 'bank teller'], ['banking'], ['cash handling'], ['customer service', 'customer support'],
    ['accounting', 'accountant'], ['tally'], ['gst'], ['finance'], ['audit'], ['payroll'],
    ['human resources', 'hr'], ['recruitment', 'talent acquisition'], ['sales'], ['business development'],
    ['marketing'], ['digital marketing'], ['seo'], ['content writing', 'content writer'], ['social media'],
    ['operations'], ['supply chain'], ['logistics'], ['procurement'], ['bpo'], ['telecalling', 'telecaller'],
    ['graphic design', 'graphic designer'], ['video editing'], ['teaching', 'teacher'], ['mechanical engineer'],
    ['civil engineer'], ['electrical engineer'], ['autocad'], ['nursing', 'nurse'], ['pharma', 'pharmacy']
  ];
  const ALIASES = new Map(SKILLS.map(row => [row[0], row]));

  // Too short or too common to trust on their own in a LinkedIn post.
  const AMBIGUOUS = new Set(['go', 'ts', 'js', 'ml', 'hr', 'node', 'spring', 'express', 'mean', 'rails', 'ux']);

  const reCache = new Map();
  function termRegex(term) {
    if (!reCache.has(term)) {
      const esc = term.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&').replace(/\s+/g, '[\\s-]+');
      reCache.set(term, new RegExp('(?<![A-Za-z0-9+#.])' + esc + '(?![A-Za-z0-9+#]|\\.[A-Za-z])', 'gi'));
    }
    return reCache.get(term);
  }

  function countTerm(text, canonical) {
    const variants = ALIASES.get(canonical) || [canonical];
    let n = 0;
    for (const v of variants) {
      const hits = text.match(termRegex(v));
      if (hits) n += hits.length;
    }
    return n;
  }

  const STOP = new Set(('about above after also and any are been being both but can could did does done each ' +
    'for from had has have having here into its more most not our out over own same should some such than that ' +
    'the their them then there these they this those through under until very was were what when where which ' +
    'while who will with would you your work worked working team teams using used use experience experienced ' +
    'year years month months project projects skills skill education university college school company resume ' +
    'email phone address linkedin github responsible responsibilities developed developing managed managing ' +
    'including various strong good knowledge ability present currently role roles based within across january ' +
    'february march april june july august september october november december india professional summary ' +
    'objective bachelor master degree technologies technology tools languages language').split(' '));

  // alias -> canonical, for every spelling in SKILLS
  const CANON = new Map();
  for (const row of SKILLS) for (const a of row) CANON.set(a, row[0]);

  const SKILL_HEAD = /^(?:technical\s+|key\s+|core\s+|professional\s+|it\s+)?skills?(?:\s*(?:&|and)\s*[a-z]+)?(?:\s+(?:summary|set))?\s*[:\-–]?\s*(.*)$/i;
  const NEXT_HEAD = /^(?:work\s+|professional\s+|relevant\s+)?(?:experience|education|projects?|certifications?|summary|objective|achievements?|awards?|personal details|declaration|internships?|employment|publications?|interests|hobbies|profile)\b/i;

  /**
   * Terms listed under the resume's "Skills" heading, in the order written.
   * Catches skills that are not in the built-in list.
   */
  function skillSectionTerms(resumeText) {
    const lines = String(resumeText || '').split(/\r?\n/).map(l => l.trim());
    const at = lines.findIndex(l => l.length < 60 && SKILL_HEAD.test(l) && (l.length < 28 || /[:\-–]/.test(l)));
    if (at < 0) return [];
    const block = [lines[at].match(SKILL_HEAD)[1] || ''];
    for (let j = at + 1; j < lines.length && block.length < 14; j++) {
      if (NEXT_HEAD.test(lines[j])) break;
      if (lines[j]) block.push(lines[j]);
    }
    const out = [];
    for (let line of block) {
      line = line.replace(/^[^:,]{2,30}:\s*/, '');            // "Languages: Python, Java" -> "Python, Java"
      for (let t of line.split(/[,|;•·●▪◦\t]|\s{2,}|\s\/\s/)) {
        t = t.replace(/\(.*?\)/g, ' ').toLowerCase().replace(/^[\s\-–*]+|[\s.]+$/g, '').replace(/\s+/g, ' ');
        if (t.length < 2 || t.length > 25 || t.split(' ').length > 3) continue;
        if (!/[a-z]/.test(t) || /^\d/.test(t) || t.split(' ').some(w => STOP.has(w))) continue;
        if (!out.includes(t)) out.push(t);
      }
    }
    return out;
  }

  /** Pull likely search keywords out of resume text. Returns lowercase strings, most frequent first. */
  function extractKeywords(resumeText, max) {
    const text = String(resumeText || '');
    const found = [];
    for (const [canonical] of SKILLS) {
      const n = countTerm(text, canonical);
      if (n > 0) found.push([canonical, n]);
    }
    found.sort((a, b) => b[1] - a[1]);
    let out = found.map(f => f[0]);
    // Drop a short alias-only hit when it only came from an ambiguous token appearing once.
    out = out.filter(k => !(AMBIGUOUS.has(k) && found.find(f => f[0] === k)[1] < 2 && k.length <= 2));
    // Skills written under the resume's "Skills" heading that the built-in list does not know.
    let extra = 0;
    for (const term of skillSectionTerms(text)) {
      if (extra >= 10) break;
      const known = CANON.get(term);
      if (known ? out.includes(known) : out.includes(term)) continue;
      if (known && AMBIGUOUS.has(known)) continue;
      out.push(known || term);
      extra++;
    }
    if (out.length < 5) {
      // Resume outside the built-in list: fall back to its most repeated words.
      const freq = new Map();
      for (const w of text.toLowerCase().match(/[a-z][a-z+#.]{3,}/g) || []) {
        const word = w.replace(/\.+$/, '');
        if (STOP.has(word) || out.includes(word)) continue;
        freq.set(word, (freq.get(word) || 0) + 1);
      }
      const extra = [...freq.entries()].filter(e => e[1] >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10);
      out = out.concat(extra.map(e => e[0]));
    }
    return out.slice(0, max || 30);
  }

  /** Which of the user's keywords appear in a post. */
  function matchKeywords(postText, keywords) {
    const text = String(postText || '');
    const hits = [];
    for (const k of keywords || []) {
      const key = String(k).toLowerCase().trim();
      if (key && countTerm(text, key) > 0) hits.push(key);
    }
    return hits;
  }

  // ---------- LinkedIn search ideas ----------

  const TITLE_WORDS = ['Engineer', 'Developer', 'Analyst', 'Scientist', 'Manager', 'Designer', 'Consultant',
    'Architect', 'Tester', 'Executive', 'Specialist', 'Administrator', 'Accountant', 'Programmer',
    'Recruiter', 'Writer', 'Teacher', 'Nurse'];
  const TITLE_END = new RegExp('(?:' + TITLE_WORDS.join('|') + '|sde|scrum master|teller)$', 'i');
  const TITLE_RE = new RegExp(
    "((?:[A-Z][A-Za-z0-9+#./&-]*[ \\t]+){1,3})(" +
    TITLE_WORDS.map(w => w + '|' + w.toUpperCase()).join('|') + ')(?![A-Za-z])', 'g');
  const SENIORITY = /^(senior|sr\.?|junior|jr\.?|lead|principal|staff|associate|assistant|trainee|chief|head|intern)\s+/i;
  const NOT_TITLE = new Set(['hiring manager', 'reporting manager']);
  const TITLE_JUNK = new Set(['a', 'an', 'the', 'as', 'and', 'of', 'to', 'for', 'with', 'by', 'in', 'at',
    'our', 'my', 'reporting', 'hiring', 'i', 'was', 'is']);

  /** Job titles written in the resume ("GenAI Engineer", "Data Analyst"). Lowercase, most used first. */
  function extractTitles(resumeText, max) {
    const text = String(resumeText || '');
    const seen = new Map();
    let m;
    TITLE_RE.lastIndex = 0;
    while ((m = TITLE_RE.exec(text))) {
      let words = (m[1] + m[2]).trim().split(/\s+/);
      // Drop leading words that are not part of a title ("Worked As Python Developer").
      while (words.length > 1 && (TITLE_JUNK.has(words[0].toLowerCase()) || /[.:,]$/.test(words[0]))) words.shift();
      let t = words.join(' ').toLowerCase().replace(/[/&]+$/, '');
      while (SENIORITY.test(t)) t = t.replace(SENIORITY, '');
      if (t.split(' ').length < 2 || t.length > 40 || NOT_TITLE.has(t)) continue;
      if (t.split(' ').some(w => TITLE_JUNK.has(w))) continue;
      const hit = seen.get(t) || { n: 0, at: m.index };
      hit.n++;
      seen.set(t, hit);
    }
    return [...seen.entries()]
      .sort((a, b) => (b[1].n - a[1].n) || (a[1].at - b[1].at))
      .slice(0, max || 3).map(e => e[0]);
  }

  // Skill -> the job title recruiters usually write for it.
  const ROLE_FOR = {
    'javascript': 'javascript developer', 'typescript': 'typescript developer', 'python': 'python developer',
    'java': 'java developer', 'c++': 'c++ developer', 'c#': 'c# developer', '.net': '.net developer',
    'go': 'golang developer', 'php': 'php developer', 'kotlin': 'android developer', 'swift': 'ios developer',
    'react': 'react developer', 'react native': 'react native developer', 'angular': 'angular developer',
    'vue': 'vue developer', 'next.js': 'next.js developer', 'node.js': 'node.js developer',
    'django': 'django developer', 'spring boot': 'java spring boot developer', 'laravel': 'laravel developer',
    'flutter': 'flutter developer', 'android': 'android developer', 'ios': 'ios developer',
    'aws': 'aws engineer', 'azure': 'azure engineer', 'devops': 'devops engineer', 'kubernetes': 'devops engineer',
    'selenium': 'automation tester', 'manual testing': 'manual tester', 'automation testing': 'automation test engineer',
    'qa': 'qa engineer', 'machine learning': 'machine learning engineer', 'deep learning': 'deep learning engineer',
    'nlp': 'nlp engineer', 'generative ai': 'generative ai engineer', 'llm': 'ai engineer',
    'artificial intelligence': 'ai engineer', 'rag': 'generative ai engineer', 'langchain': 'generative ai engineer',
    'mlops': 'mlops engineer', 'computer vision': 'computer vision engineer',
    'data science': 'data scientist', 'data analysis': 'data analyst', 'data engineering': 'data engineer',
    'power bi': 'power bi developer', 'tableau': 'tableau developer', 'sql': 'sql developer',
    'sap': 'sap consultant', 'salesforce': 'salesforce developer', 'servicenow': 'servicenow developer',
    'figma': 'ui ux designer', 'ui/ux': 'ui ux designer', 'cybersecurity': 'cybersecurity analyst',
    'embedded': 'embedded engineer', 'accounting': 'accountant', 'human resources': 'hr executive',
    'recruitment': 'hr recruiter', 'sales': 'sales executive', 'business development': 'business development executive',
    'marketing': 'marketing executive', 'digital marketing': 'digital marketing executive', 'seo': 'seo executive',
    'content writing': 'content writer', 'customer service': 'customer support executive',
    'graphic design': 'graphic designer', 'video editing': 'video editor', 'teaching': 'teacher',
    'nursing': 'staff nurse', 'frontend': 'frontend developer', 'backend': 'backend developer',
    'full stack': 'full stack developer', 'mern': 'mern stack developer', 'mean': 'mean stack developer'
  };
  const LEVEL = new Set(['intern', 'fresher']);

  /**
   * What to type in LinkedIn's search bar, built from the resume keywords.
   * Job titles come first, then titles implied by the top skills. Each idea pairs a
   * title or skill with wording recruiters use when they put an email in a post.
   * Returns [{ query, why }].
   */
  function suggestSearches(keywords, opts) {
    const keys = (keywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean);
    const place = String((opts && opts.location) || '').trim().replace(/["\s]+/g, ' ');
    const roles = [];
    const addRole = r => { if (r && !roles.includes(r)) roles.push(r); };
    for (const k of keys) if (TITLE_END.test(k)) addRole(k);          // titles written in the resume
    for (const k of keys) if (!TITLE_END.test(k)) addRole(ROLE_FOR[k]); // titles implied by skills
    const fresher = keys.includes('fresher');
    const r1 = roles[0], r2 = roles[1], r3 = roles[2];
    const topSkills = keys.filter(k => !LEVEL.has(k) && !TITLE_END.test(k)).slice(0, 2);
    const out = [];
    const add = (query, why) => {
      query = query.replace(/\s+/g, ' ').trim();
      if (query && !out.some(o => o.query === query)) out.push({ query, why });
    };

    if (r1) {
      add(`${r1} hiring "send your resume"`, 'Your main job title with the wording recruiters use most when they give an email.');
      add(`${r1} hiring "share your cv"`, 'Same title, the other common wording.');
      if (place) add(`${r1} ${place} hiring "send your resume"`, 'Only posts that mention your city.');
      add(`${r1} hiring "gmail.com"`, 'Finds posts where the recruiter typed a Gmail address.');
    } else if (topSkills.length) {
      // No job title known: lead with the top skill instead.
      const s1 = topSkills[0];
      add(`${s1} hiring "send your resume"`, 'Your top skill with the wording recruiters use most when they give an email.');
      add(`${s1} hiring "share your cv"`, 'Same skill, the other common wording.');
      if (place) add(`${s1} ${place} hiring "send your resume"`, 'Only posts that mention your city.');
    }
    if (r2) add(`${r2} hiring "send your resume"`, 'Your second job title.');
    if (topSkills.length) {
      add(`${topSkills.join(' ')} hiring "resume to"`, 'Your top skills, for posts that do not use your exact title.');
    }
    if (r1 && fresher) add(`${r1} fresher hiring "send your resume"`, 'Entry-level openings.');
    if (r1) add(`${r1} "immediate joiner" hiring`, 'Urgent openings. Use this if you can join quickly.');
    if (r3) add(`${r3} hiring "share your cv"`, 'Your third job title.');
    if (r1) add(`"we are hiring" ${r1} "drop your resume"`, 'Company announcements instead of recruiter posts.');
    if (!r1 && !topSkills.length && place) add(`hiring ${place} "send your resume"`, 'Any opening in your city.');
    return out.slice(0, 8);
  }

  const DATE_FILTERS = { day: 'past-24h', week: 'past-week', month: 'past-month' };

  /** LinkedIn Posts search for a query, newest first. when: 'day' | 'week' | 'month' | 'any'. */
  function searchUrl(query, when) {
    let url = 'https://www.linkedin.com/search/results/content/?keywords=' +
      encodeURIComponent(String(query || '').trim()) + '&origin=FACETED_SEARCH&sortBy=%22date_posted%22';
    if (DATE_FILTERS[when]) url += '&datePosted=%22' + DATE_FILTERS[when] + '%22';
    return url;
  }

  // ---------- fit: is this post worth a mail? ----------

  const NUM = '(\\d{1,2}(?:\\.\\d)?)';
  const YRS = '(?:years?|yrs?|yoe)';
  const DASH = '(?:-|–|—|to)';

  /** Experience asked for in a post. Returns [{ lo, hi }] (hi may be Infinity), one per range found. */
  function parseExperience(postText) {
    let text = ' ' + String(postText || '') + ' ';
    const out = [];
    const take = (re, fn) => {
      text = text.replace(re, (...m) => {
        const r = fn(m);
        if (r && r.lo <= 30 && (r.hi === Infinity || (r.hi <= 40 && r.hi >= r.lo))) out.push(r);
        return ' ~ ';
      });
    };
    const n = v => parseFloat(v);
    // "3-5 years", "3 to 5 yrs", "Exp: 4 - 6"
    take(new RegExp(NUM + '\\s*\\+?\\s*' + DASH + '\\s*' + NUM + '\\s*\\+?\\s*' + YRS, 'gi'), m => ({ lo: n(m[1]), hi: n(m[2]) }));
    take(new RegExp('\\b(?:experience|exp)\\.?(?:\\s+(?:required|level|range))?\\s*[:\\-–]\\s*' + NUM + '\\s*' + DASH + '\\s*' + NUM, 'gi'),
      m => ({ lo: n(m[1]), hi: n(m[2]) }));
    // "5+ years", "Exp: 5+", "minimum 4 years"
    take(new RegExp(NUM + '\\s*\\+\\s*' + YRS, 'gi'), m => ({ lo: n(m[1]), hi: Infinity }));
    take(new RegExp('\\b(?:experience|exp)\\.?\\s*[:\\-–]\\s*' + NUM + '\\s*\\+', 'gi'), m => ({ lo: n(m[1]), hi: Infinity }));
    take(new RegExp('\\b(?:min(?:imum)?|at\\s?least)\\.?\\s*(?:of\\s*)?' + NUM + '\\s*' + YRS, 'gi'), m => ({ lo: n(m[1]), hi: Infinity }));
    // "4 years of experience", "Experience: 4 years" -> read as a minimum
    take(new RegExp(NUM + '\\s*' + YRS + '(?:\\s+of)?(?:\\s+[A-Za-z/.+#-]+){0,3}\\s+(?:experience|exp)\\b', 'gi'), m => ({ lo: n(m[1]), hi: Infinity }));
    take(new RegExp('\\b(?:experience|exp)\\.?\\s*[:\\-–]\\s*' + NUM + '\\s*' + YRS, 'gi'), m => ({ lo: n(m[1]), hi: Infinity }));
    if (/\bfreshers?\b/i.test(text)) out.push({ lo: 0, hi: 1 });
    return out;
  }

  const expLabel = r => (r.hi === Infinity ? r.lo + '+' : r.lo === r.hi ? String(r.lo) : r.lo + '-' + r.hi) + ' yrs';

  // One year short is normal to apply for; far above the top of the range is not.
  function expFits(years, r) {
    const above = r.hi === Infinity ? Infinity : r.hi + Math.max(1, r.hi * 0.25);
    return years >= r.lo - 1 && years <= above;
  }

  /** Total years of experience stated in a resume ("3.5 years of experience"), or null. */
  function guessYears(resumeText) {
    const m = String(resumeText || '').match(
      new RegExp(NUM + '\\s*\\+?\\s*' + YRS + '(?:\\s+of)?(?:\\s+[A-Za-z/.+#-]+){0,3}\\s+experience', 'i'));
    return m && parseFloat(m[1]) <= 40 ? parseFloat(m[1]) : null;
  }

  // [canonical, ...aliases]
  const PLACES = [
    ['bangalore', 'bengaluru'], ['hyderabad', 'secunderabad'], ['pune'], ['mumbai', 'navi mumbai', 'thane'],
    ['delhi', 'new delhi', 'ncr', 'delhi ncr'], ['gurgaon', 'gurugram'], ['noida', 'greater noida'], ['chennai'],
    ['kolkata'], ['ahmedabad', 'gandhinagar'], ['jaipur'], ['indore'], ['kochi', 'cochin'], ['coimbatore'],
    ['chandigarh', 'mohali'], ['bhubaneswar'], ['trivandrum', 'thiruvananthapuram'], ['nagpur'], ['lucknow'],
    ['vadodara'], ['surat'], ['mysore', 'mysuru'], ['vizag', 'visakhapatnam'], ['india']
  ];
  const ABROAD = [
    ['usa', 'united states', 'u.s.', 'us citizens?', 'us based', 'us only', 'new york', 'new jersey', 'texas',
      'california', 'chicago', 'atlanta', 'seattle', 'dallas', 'boston', 'florida', 'virginia'],
    ['uk', 'united kingdom', 'london'], ['canada', 'toronto'], ['uae', 'dubai', 'abu dhabi'], ['singapore'],
    ['germany', 'berlin'], ['australia', 'sydney', 'melbourne'], ['saudi', 'saudi arabia', 'riyadh'], ['qatar', 'doha']
  ];
  const placeRe = row => new RegExp('(?<![A-Za-z])(?:' +
    row.map(a => a.replace(/[.]/g, '\\.').replace(/\s+/g, '[\\s-]+')).join('|') + ')(?![A-Za-z])', 'i');
  const PLACE_RES = PLACES.map(r => [r[0], placeRe(r), false]).concat(ABROAD.map(r => [r[0], placeRe(r), true]));
  const REMOTE_RE = /\b(remote|work from home|wfh|work from anywhere)\b/i;
  const PLACE_ALIAS = new Map();
  for (const row of PLACES.concat(ABROAD)) for (const a of row) PLACE_ALIAS.set(a, row[0]);

  // "Location: Nashik / Indore (Hybrid)" names places the built-in list may not know.
  const LOC_LINE = /(?:^|\n)[^\nA-Za-z]{0,12}(?:job\s+|work\s+|base\s+|office\s+)?locations?\s*[:\-–]\s*([^\n]{2,80})/i;
  const ANY_PLACE = /\bpan[\s-]?india\b|\banywhere in india\b|\bacross india\b|\bany location\b|\bmultiple locations\b|\ball locations\b/i;
  const NOT_PLACE = /^(?:onsite|on-site|on site|hybrid|wfo|wfh|remote|office|india|tbd|flexible|anywhere|open|negotiable|na|n a)$|\b(?:days?|weeks?|office|mode|work|shift|time|timings?|only|preferred|candidates?|client|based|location|experience|years?|yrs?|immediate|notice|salary|ctc|lpa|budget)\b/i;

  /**
   * Places a post names.
   * home / abroad: known places. other: names read from a "Location:" line that are not in the list.
   * remote: says remote or work from home. any: says "Pan India" or similar.
   */
  function findPlaces(postText) {
    const text = String(postText || '');
    const home = [], abroad = [], other = [];
    for (const [name, re, isAbroad] of PLACE_RES) if (re.test(text)) (isAbroad ? abroad : home).push(name);
    const line = text.match(LOC_LINE);
    if (line) {
      for (let part of line[1].split(/[,/|&;()]|\bor\b|\band\b|\s[-–]\s/i)) {
        part = part.replace(/[^A-Za-z .'-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        if (part.length < 3 || part.length > 25 || part.split(' ').length > 3 || NOT_PLACE.test(part)) continue;
        if (REMOTE_RE.test(part) || PLACE_RES.some(p => p[1].test(part))) continue;
        if (!other.includes(part)) other.push(part);
      }
    }
    return { home, abroad, other, remote: REMOTE_RE.test(text), any: ANY_PLACE.test(text) };
  }

  // ---------- job details saved with each contact ----------

  const ROLE_LABEL = /^[ \t>*•\-–#\d.)]*(?:job\s+)?(?:role|position|job title|designation|profile|title|opening|hiring for|we are hiring|hiring)\s*[:\-–]\s*(.+)$/im;
  const ROLE_LEAD_JUNK = new Set(['hiring', 'urgent', 'urgently', 'immediate', 'required', 'requirement', 'wanted',
    'need', 'needed', 'looking', 'opening', 'openings', 'job', 'new', 'we', 'are', 'now', 'for', 'a', 'an', 'the',
    'multiple', 'role', 'position', 'our', 'join', 'us', 'as']);

  /**
   * The job a post is about. A "Role: ..." line first, then a job title written in the post
   * (one that contains a title from your resume wins), then your own title if the post mentions it.
   */
  function guessRole(postText, keywords) {
    const text = String(postText || '');
    const tidy = v => String(v).replace(/[*_#`]+/g, ' ').replace(/\s+/g, ' ')
      .replace(/\s*(?:[|(\[]|\s[-–—]\s|,\s|\.\s|\s(?:with|at|for|in|having|who|location|exp(?:erience)?)\b).*$/i, '')
      .replace(/[\s:.\-–]+$/, '').trim().slice(0, 60);
    const label = text.match(ROLE_LABEL);
    if (label) {
      const r = tidy(label[1]);
      if (r.length >= 3 && /[A-Za-z]{3}/.test(r)) return r;
    }
    const mine = (keywords || []).map(k => String(k).toLowerCase()).filter(k => TITLE_END.test(k));
    const found = [];
    let m;
    TITLE_RE.lastIndex = 0;
    while ((m = TITLE_RE.exec(text)) && found.length < 12) {
      const words = (m[1] + m[2]).trim().split(/\s+/);
      while (words.length > 1 && ROLE_LEAD_JUNK.has(words[0].toLowerCase().replace(/[^a-z]/g, ''))) words.shift();
      if (words.length >= 2) found.push(words.join(' '));
    }
    const wanted = found.find(f => mine.some(t => f.toLowerCase().includes(t)));
    if (wanted) return wanted;
    const hit = mine.find(t => countTerm(text, t) > 0);
    if (hit) return cap(hit).replace(/\b(Ai|Ml|Qa|Ui|Ux|Hr|Sde|Nlp|Llm|Sap|Seo|Genai)\b/g, w => w === 'Genai' ? 'GenAI' : w.toUpperCase());
    return found[0] || '';
  }

  /** Places a post names, for the sheet: "Bangalore, Hyderabad, Remote". */
  function placeLabel(postText) {
    const f = findPlaces(postText);
    const names = f.home.filter(p => p !== 'india').concat(f.other).map(cap)
      .concat(f.abroad.map(a => a.length <= 3 ? a.toUpperCase() : cap(a)));
    if (f.any) names.push('Pan India');
    else if (!names.length && f.home.includes('india')) names.push('India');
    if (f.remote) names.push('Remote');
    return names.slice(0, 4).join(', ');
  }

  // "consultants" marks an agency; "consulting" and "consultancy" do not (many are ordinary IT employers).
  const AGENCY_NAME = /staffing|recruit|placement|manpower|talent|head\s?hunt|consultant|outsourc|\bhr\s?(?:solutions|services)|job|career|\bsearch\b|hiring/i;
  const AGENCY_TEXT = /\b(?:our|my|the) (?:esteemed |reputed |leading |direct |end )?clients?\b|\bfor (?:a|one of (?:our|the)) clients?\b|\bclient\s*[:\-–]|\bc2h\b|contract[\s-]to[\s-]hire|third[\s-]party payroll|\bon (?:our|the) payroll\b|\bimplementation partner\b/i;

  /**
   * Who is behind a contact.
   * kind: 'consultancy' (agency wording in the post, or an agency-style company name or email domain),
   *       'company' (a company email address and no agency signs), or '' (cannot tell).
   * personal: true when the address is Gmail, Yahoo, Outlook and so on.
   */
  function companyType(lead) {
    const domain = String(lead.email || '').split('@')[1] || '';
    const personal = FREE_MAIL.has(domain);
    const names = String(lead.company || '') + ' ' + (personal ? '' : domain.split('.')[0]);
    let kind = '';
    if (AGENCY_TEXT.test(String(lead.text || '')) || AGENCY_NAME.test(names)) kind = 'consultancy';
    else if (domain && !personal) kind = 'company';
    return { kind, personal };
  }

  /**
   * Short id of a post, used to tell "the same post again" from "a new post by the same person".
   * LinkedIn's own post number when the link has one, otherwise a hash of the post text.
   */
  function postKey(url, text) {
    const m = String(url || '').match(/urn:li:(?:activity|share|ugcPost):(\d+)/) ||
      String(url || '').match(/\/posts\/[^/?#]*?(\d{10,})/);
    if (m) return 'p' + m[1];
    const norm = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 400);
    let h1 = 0x811c9dc5, h2 = 5381;
    for (let i = 0; i < norm.length; i++) {
      const c = norm.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = (Math.imul(h2, 33) + c) >>> 0;
    }
    return 't' + h1.toString(36) + h2.toString(36);
  }

  /** "a, b ,C" -> ['a', 'b', 'c'] */
  function splitList(value) {
    return String(value || '').split(/[,;\n]/).map(v => v.trim().toLowerCase()).filter(Boolean);
  }

  const squash = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const cap = v => String(v).replace(/\b[a-z]/g, c => c.toUpperCase());

  /**
   * Decide whether a contact is worth mailing, and how good a match it is.
   * lead:  { text, email, company, headline, matched, hiring }
   * prefs: { years, locations[], exclude[], blocked[], mailed (Set of squashed company names) }
   * Returns { score 0-100, blocked: reason or null, notes: [{ text, kind: 'good' | 'warn' | 'info' }] }.
   */
  function assessFit(lead, prefs) {
    const p = prefs || {};
    const text = String(lead.text || '');
    const notes = [];
    let blocked = null;
    let score = 0;

    // 1. Words that rule the post out.
    for (const word of p.exclude || []) {
      if (countTerm(text, word) > 0) { blocked = 'has “' + word + '”'; break; }
    }

    // A job seeker's own post is not a lead.
    if (!blocked && looksLikeJobSeeker(text, lead.headline)) blocked = 'looks like a job seeker’s own post';

    // 2. Companies never to contact: company guess, email domain and the poster's headline.
    const where = [squash(lead.company), squash(String(lead.email || '').split('@')[1]), squash(lead.headline)];
    for (const name of p.blocked || []) {
      const key = squash(name);
      if (key.length >= 3 && where.some(w => w && w.includes(key))) { blocked = blocked || 'blocked company: ' + name; break; }
    }

    // 3. Skills and job title.
    const matched = lead.matched || [];
    const titles = matched.filter(k => TITLE_END.test(k));
    score += Math.min(50, (matched.length - titles.length) * 12);
    if (titles.length) score += 20;

    // 4. Experience.
    const years = typeof p.years === 'number' && !isNaN(p.years) ? p.years : null;
    const ranges = parseExperience(text);
    if (ranges.length && years != null) {
      const ok = ranges.find(r => expFits(years, r));
      if (ok) { score += 15; notes.push({ text: expLabel(ok), kind: 'good' }); }
      else {
        blocked = blocked || 'asks ' + ranges.map(expLabel).join(', ') + ', you have ' + years;
        notes.push({ text: ranges.map(expLabel).join(', '), kind: 'warn' });
      }
    } else if (ranges.length) {
      score += 6; notes.push({ text: ranges.map(expLabel).join(', '), kind: 'info' });
    } else score += 6;

    // 5. Location.
    const want = (p.locations || []).map(l => PLACE_ALIAS.get(l) || l);
    const found = findPlaces(text);
    // "India" on its own is not a specific place: it never rules a post out.
    const cities = found.home.filter(h => h !== 'india').concat(found.other);
    const far = found.abroad.map(a => a.length <= 3 ? a.toUpperCase() : cap(a));
    if (want.length) {
      const hit = want.find(w => w !== 'remote' && (found.home.includes(w) || found.abroad.includes(w) ||
        found.other.includes(w) || (!PLACE_ALIAS.has(w) && countTerm(text, w) > 0)));
      const abroadOnly = found.abroad.length && !found.home.length && !found.other.length;
      if (hit) { score += 10; notes.push({ text: cap(hit), kind: 'good' }); }
      else if (abroadOnly) {
        blocked = blocked || 'location: ' + far.join(', ');
        notes.push({ text: far.join(', '), kind: 'warn' });
      } else if (found.remote) { score += 10; notes.push({ text: 'Remote', kind: 'good' }); }
      else if (found.any) { score += 10; notes.push({ text: 'Pan India', kind: 'good' }); }
      else if (cities.length) {
        blocked = blocked || 'location: ' + cities.map(cap).join(', ');
        notes.push({ text: cities.map(cap).join(', '), kind: 'warn' });
      } else score += 4;
    } else {
      score += 4;
      const all = cities.map(cap).concat(far);
      if (all.length) notes.push({ text: all.slice(0, 2).join(', '), kind: 'info' });
      else if (found.remote) notes.push({ text: 'Remote', kind: 'info' });
    }

    if (lead.hiring) score += 5;

    // 6. Already mailed someone at this company from this extension.
    const co = squash(lead.company);
    if (!lead.sent && co && p.mailed && p.mailed.has(co)) { score -= 10; notes.push({ text: 'mailed this company before', kind: 'info' }); }

    return { score: Math.max(0, Math.min(100, Math.round(score))), blocked, notes };
  }

  const api = {
    findEmails, deobfuscate, companyFromEmail, cleanName, guessCompany,
    looksLikeHiring, extractKeywords, matchKeywords, extractTitles, suggestSearches, searchUrl,
    parseExperience, guessYears, findPlaces, splitList, assessFit, postKey, looksLikeJobSeeker,
    guessRole, placeLabel, companyType
  };
  root.LeadExtract = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
