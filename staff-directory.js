// Staff names live in public.contacts on the shared Docket database.
// A name in that directory is a coworker, not the prospective client.

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

function norm(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function staffAliases(person) {
  const aliases = [person.name];
  const local = String(person.email || "").split("@")[0]?.toLowerCase() ?? "";
  const parts = person.name.split(/\s+/);
  const first = parts[0]?.toLowerCase() ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const lastKey = last.toLowerCase().replace(/[^a-z]/g, "");
  if (
    last &&
    /^[a-z]{4,12}$/.test(local) &&
    local !== first &&
    lastKey &&
    !local.includes(lastKey)
  ) {
    aliases.push(`${local[0].toUpperCase()}${local.slice(1)} ${last}`);
  }
  return aliases;
}

export function matchStaff(name, staff) {
  const key = norm(name);
  if (key.length < 3) return null;
  return staff.find((person) => person.aliases.some((alias) => norm(alias) === key)) ?? null;
}

export function staffPromptLine(staff) {
  if (!staff.length) return "";
  const listed = staff.map((person) => {
    const extras = person.aliases.filter((alias) => norm(alias) !== norm(person.name));
    return extras.length ? `${person.name} (also ${extras.join(", ")})` : person.name;
  });
  return `\n\nThese people work at the firm. Never put one of them in client.name, including the "also" names. client.name is only the prospective client. If the only person named is staff, set client.name to null. Staff: ${listed.join("; ")}.`;
}

async function connect(firm) {
  const pg = await import("pg");
  const { Client } = pg.default || pg;
  const disableSsl = /sslmode=disable/i.test(firm.caseDbUrl);
  const client = new Client({
    connectionString: firm.caseDbUrl,
    ssl: disableSsl ? false : { rejectUnauthorized: false },
    statement_timeout: 20000,
  });
  await client.connect();
  return client;
}

export async function loadStaffDirectory(firm) {
  if (!firm?.caseDbUrl) return [];
  const hit = cache.get(firm.id);
  if (hit && hit.expires > Date.now()) return hit.people;

  let client;
  try {
    client = await connect(firm);
    const { rows } = await client.query(
      `select name, email
       from public.contacts
       where name is not null
         and btrim(name) <> ''
         and name !~* '^(referred|legal assistant)$'
       order by name`,
    );
    const people = rows.map((row) => {
      const person = { name: String(row.name).trim(), email: row.email || null };
      person.aliases = staffAliases(person);
      return person;
    });
    cache.set(firm.id, { expires: Date.now() + CACHE_MS, people });
    return people;
  } catch (err) {
    console.error(`[${firm.id}][staff] Could not read the staff directory:`, err.message);
    return [];
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}
