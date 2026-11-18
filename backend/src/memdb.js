import { randomBytes } from 'node:crypto';

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const OPS = { '==': (a, b) => a === b, in: (a, b) => b.includes(a) };

class Snapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = data !== undefined;
    this._data = data;
  }
  data() {
    return clone(this._data);
  }
}

class DocRef {
  constructor(store, col, id) {
    Object.assign(this, { store, col, id });
  }
  get map() {
    if (!this.store.has(this.col)) this.store.set(this.col, new Map());
    return this.store.get(this.col);
  }
  async get() {
    return new Snapshot(this, clone(this.map.get(this.id)));
  }
  async set(data, opts = {}) {
    const cur = this.map.get(this.id);
    this.map.set(this.id, clone(opts.merge && cur ? { ...cur, ...data } : data));
  }
  async update(data) {
    const cur = this.map.get(this.id);
    if (!cur) throw Object.assign(new Error(`NOT_FOUND: ${this.col}/${this.id}`), { code: 5 });
    this.map.set(this.id, { ...cur, ...clone(data) });
  }
  async create(data) {
    if (this.map.has(this.id)) throw Object.assign(new Error(`ALREADY_EXISTS: ${this.col}/${this.id}`), { code: 6 });
    this.map.set(this.id, clone(data));
  }
  async delete() {
    this.map.delete(this.id);
  }
}

class Query {
  constructor(store, col, filters = []) {
    Object.assign(this, { store, col, filters });
  }
  where(field, op, value) {
    if (!OPS[op]) throw new Error(`memdb: operador ${op} não suportado`);
    return new Query(this.store, this.col, [...this.filters, [field, op, value]]);
  }
  async get() {
    const docs = [...(this.store.get(this.col) ?? new Map())]
      .filter(([, d]) => this.filters.every(([f, op, v]) => OPS[op](d[f], v)))
      .map(([id, d]) => new Snapshot(new DocRef(this.store, this.col, id), clone(d)));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class CollectionRef extends Query {
  doc(id = randomBytes(10).toString('hex')) {
    return new DocRef(this.store, this.col, id);
  }
}

export function createMemoryDb() {
  const store = new Map();
  let queue = Promise.resolve();
  return {
    collection: (name) => new CollectionRef(store, name),
    runTransaction(fn) {
      const run = queue.then(async () => {
        const writes = [];
        const tx = {
          get: (target) => target.get(),
          set: (ref, data, opts) => (writes.push(['set', ref, data, opts]), tx),
          update: (ref, data) => (writes.push(['update', ref, data]), tx),
          create: (ref, data) => (writes.push(['create', ref, data]), tx),
          delete: (ref) => (writes.push(['delete', ref]), tx),
        };
        const result = await fn(tx);
        for (const [op, ref] of writes) {
          if (op === 'create' && ref.map.has(ref.id)) throw Object.assign(new Error(`ALREADY_EXISTS: ${ref.col}/${ref.id}`), { code: 6 });
          if (op === 'update' && !ref.map.has(ref.id)) throw Object.assign(new Error(`NOT_FOUND: ${ref.col}/${ref.id}`), { code: 5 });
        }
        for (const [op, ref, data, opts] of writes) await ref[op](data, opts);
        return result;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}
