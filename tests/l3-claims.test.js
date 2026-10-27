import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseClaimsAnswer, verifyClaims } from '../src/l3/claims.js';

// Facts as buildL1Context numbers them: symbols, then relations between them.
const facts = new Map([
  [1, { symbol: 'App\\Http\\Controllers\\AuthController::login', kind: 'method', path: 'app/Http/Controllers/AuthController.php', line_range: [10, 20] }],
  [2, { symbol: 'App\\Services\\TokenService::issue', kind: 'method', path: 'app/Services/TokenService.php', line_range: [5, 15] }],
  [3, { symbol: 'App\\Models\\User', kind: 'class', path: 'app/Models/User.php', line_range: [1, 40] }],
  [4, { path: 'app/Http/Controllers/AuthController.php', line_range: [10, 20], relation: { kind: 'calls', from: 'App\\Http\\Controllers\\AuthController::login', to: 'App\\Services\\TokenService::issue' } }],
]);
const relations = [
  { from: { symbol: 'App\\Http\\Controllers\\AuthController::login' }, to: { symbol: 'App\\Services\\TokenService::issue' }, kind: 'calls' },
];
const check = (sentences, suggestions = []) => verifyClaims({ sentences }, { facts, relations, suggestions });

describe('parseClaimsAnswer', () => {
  it('reads the object, also inside a json fence or with words around it', () => {
    const json = '{"sentences": [{"text": "A.", "claims": []}]}';
    assert.deepStrictEqual(parseClaimsAnswer(json), { sentences: [{ text: 'A.', claims: [] }] });
    assert.ok(parseClaimsAnswer('```json\n' + json + '\n```'));
    assert.ok(parseClaimsAnswer('Here it is: ' + json));
  });

  it('returns null for prose, broken JSON or no sentences', () => {
    assert.strictEqual(parseClaimsAnswer('The login calls issue. evidence: [1]'), null);
    assert.strictEqual(parseClaimsAnswer('{"sentences": [ {"text": '), null);
    assert.strictEqual(parseClaimsAnswer('{"sentences": []}'), null);
    assert.strictEqual(parseClaimsAnswer(null), null);
  });
});

describe('verifyClaims', () => {
  it('keeps a relation stated by a graph relation', () => {
    const { kept, dropped } = check([{
      text: 'AuthController::login calls TokenService::issue.',
      claims: [{ type: 'relation', subject: 'AuthController::login', relation: 'calls', object: 'issue', fact: 4 }],
    }]);
    assert.strictEqual(dropped.length, 0);
    assert.deepStrictEqual(kept[0].factIds, [4]);
  });

  it('drops a relation that is not in the graph', () => {
    const { kept, dropped } = check([{
      text: 'TokenService::issue calls AuthController::login.',
      claims: [{ type: 'relation', subject: 'issue', relation: 'calls', object: 'login', fact: 4 }],
    }]);
    assert.strictEqual(kept.length, 0);
    assert.match(dropped[0].reason, /no "calls" relation/);
  });

  it('accepts "uses" for any relation kind but not a wrong exact kind', () => {
    const uses = check([{ text: 'login uses issue.', claims: [{ type: 'relation', subject: 'login', relation: 'uses', object: 'issue', fact: 4 }] }]);
    assert.strictEqual(uses.kept.length, 1);
    const renders = check([{ text: 'login renders issue.', claims: [{ type: 'relation', subject: 'login', relation: 'renders', object: 'issue', fact: 4 }] }]);
    assert.strictEqual(renders.kept.length, 0);
  });

  it('checks that a symbol claim cites the fact of that symbol', () => {
    assert.strictEqual(check([{ text: 'The User model holds accounts.', claims: [{ type: 'symbol', symbol: 'User', fact: 3 }] }]).kept.length, 1);
    const wrong = check([{ text: 'The User model holds accounts.', claims: [{ type: 'symbol', symbol: 'User', fact: 2 }] }]);
    assert.match(wrong.dropped[0].reason, /fact 2 is not User/);
    const unknown = check([{ text: 'User exists.', claims: [{ type: 'symbol', symbol: 'User', fact: 99 }] }]);
    assert.match(unknown.dropped[0].reason, /unknown fact 99/);
  });

  it('drops a sentence naming a symbol or path without a claim', () => {
    const symbol = check([{ text: 'TokenService issues tokens for User.', claims: [{ type: 'symbol', symbol: 'TokenService::issue', fact: 2 }] }]);
    assert.match(symbol.dropped[0].reason, /names User without a claim/);
    const file = check([{ text: 'See app/Services/TokenService.php.', claims: [] }]);
    assert.match(file.dropped[0].reason, /names app\/Services\/TokenService\.php without a claim/);
  });

  it('drops a relation stated in words without a verified relation claim', () => {
    const { dropped } = check([{
      text: 'User calls TokenService::issue.',
      claims: [{ type: 'symbol', symbol: 'User', fact: 3 }, { type: 'symbol', symbol: 'issue', fact: 2 }],
    }]);
    assert.match(dropped[0].reason, /without a verified relation claim/);
  });

  it('accepts suggested files only through suggestion claims', () => {
    const ok = check([{ text: 'Create app/Services/InvoiceService.php.', claims: [{ type: 'suggestion', path: 'app/Services/InvoiceService.php' }] }], ['app/Services/InvoiceService.php']);
    assert.strictEqual(ok.kept.length, 1);
    const bad = check([{ text: 'Create app/Services/Other.php.', claims: [{ type: 'suggestion', path: 'app/Services/Other.php' }] }], ['app/Services/InvoiceService.php']);
    assert.match(bad.dropped[0].reason, /not a suggested file/);
  });

  it('keeps a sentence without claims when it names nothing', () => {
    assert.strictEqual(check([{ text: 'The facts do not answer this question.', claims: [] }]).kept.length, 1);
  });

  it('rejects unknown claim types and relations', () => {
    assert.match(check([{ text: 'x.', claims: [{ type: 'guess' }] }]).dropped[0].reason, /unknown claim type/);
    assert.match(check([{ text: 'Alpha owns Beta.', claims: [{ type: 'relation', relation: 'owns', subject: 'Alpha', object: 'Beta', fact: 4 }] }]).dropped[0].reason, /unknown relation/);
  });
});

describe('verifyClaims: classes stand for their members', () => {
  it('accepts a relation stated at class level when a member has it', () => {
    const { kept } = check([{
      text: 'AuthController calls TokenService.',
      claims: [{ type: 'relation', subject: 'AuthController', relation: 'calls', object: 'TokenService', fact: 4 }],
    }]);
    assert.strictEqual(kept.length, 1);
  });

  it('accepts a class named through the fact of one of its methods', () => {
    const { kept } = check([{ text: 'TokenService issues tokens.', claims: [{ type: 'symbol', symbol: 'TokenService', fact: 2 }] }]);
    assert.strictEqual(kept.length, 1);
  });

  it('still drops a class-level relation the members do not have', () => {
    const { dropped } = check([{
      text: 'TokenService calls AuthController.',
      claims: [{ type: 'relation', subject: 'TokenService', relation: 'calls', object: 'AuthController', fact: 4 }],
    }]);
    assert.match(dropped[0].reason, /no "calls" relation/);
  });
});

describe('verifyClaims: one sentence at a time', () => {
  const callClaim = { type: 'relation', subject: 'login', relation: 'calls', object: 'issue', fact: 4 };

  it('checks each sentence of an entry and drops only the failing one', () => {
    const { kept, dropped } = check([{
      text: 'AuthController::login calls TokenService::issue. TokenService::issue calls User.',
      claims: [callClaim, { type: 'symbol', symbol: 'User', fact: 3 }],
    }]);
    assert.deepStrictEqual(kept.map(k => k.text), ['AuthController::login calls TokenService::issue.']);
    assert.match(dropped[0].reason, /involving (User|issue) without a verified relation claim/);
  });

  it('omits repeats and sentences past the limit', () => {
    const { kept, omitted } = check([{
      text: 'AuthController::login calls TokenService::issue. Then AuthController::login calls TokenService::issue again.',
      claims: [callClaim],
    }]);
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(omitted, 1);
    const many = check(Array.from({ length: 6 }, (_, i) => ({ text: `Note ${i} about nothing.`, claims: [] })));
    assert.strictEqual(many.kept.length, 4);
    assert.strictEqual(many.omitted, 2);
  });
});

describe('verifyClaims: a failed claim only sinks the sentences about it', () => {
  it('keeps the other sentences of the entry', () => {
    const { kept, dropped } = check([{
      text: 'AuthController::login calls TokenService::issue. TokenService::issue calls AuthController::login.',
      claims: [
        { type: 'relation', subject: 'login', relation: 'calls', object: 'issue', fact: 4 },
        { type: 'relation', subject: 'issue', relation: 'calls', object: 'login', fact: 4 },
      ],
    }]);
    assert.deepStrictEqual(kept.map(k => k.text), ['AuthController::login calls TokenService::issue.']);
    assert.strictEqual(dropped.length, 1);
  });
});

describe('verifyClaims: sentence splitting and types', () => {
  it('splits before a lowercase identifier but not inside a qualified name', () => {
    const { kept } = check([{
      text: 'AuthController::login calls TokenService::issue. login is the entry point.',
      claims: [{ type: 'relation', subject: 'login', relation: 'calls', object: 'issue', fact: 4 }],
    }]);
    assert.strictEqual(kept.length, 2);
  });

  it('asks only a symbol claim for a type named next to a relation', () => {
    const typed = new Map([...facts, [5, { symbol: 'TokenResponse', kind: 'interface', path: 'app/Types.php', line_range: [1, 5] }]]);
    const { kept } = verifyClaims({ sentences: [{
      text: 'AuthController::login calls TokenService::issue and returns a TokenResponse.',
      claims: [{ type: 'relation', subject: 'login', relation: 'calls', object: 'issue', fact: 4 }, { type: 'symbol', symbol: 'TokenResponse', fact: 5 }],
    }] }, { facts: typed, relations });
    assert.strictEqual(kept.length, 1);
  });
});
