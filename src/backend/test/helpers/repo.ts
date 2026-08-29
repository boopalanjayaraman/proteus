import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A real git repository in a temp directory.
 *
 * `GitWriter` shells out to git, and a mock of git would only prove that the
 * mock behaves as the test expects. "The original branch is unchanged" is a
 * claim about git's actual state, so the test needs actual git.
 */
export interface TestRepo {
  dir: string;
  baseCommitSha: string;
  defaultBranch: string;
  /** Files at a ref, so a test can assert the base branch never moved. */
  filesAt: (ref: string) => Promise<string[]>;
  shaOf: (ref: string) => Promise<string>;
  branches: () => Promise<string[]>;
  write: (path: string, content: string) => Promise<void>;
  dispose: () => Promise<void>;
}

const SOURCE = `package pay.security;

import javax.crypto.Cipher;

public class CryptoService {
  public byte[] wrapSessionKey(java.security.PublicKey peer, javax.crypto.SecretKey session)
      throws Exception {
    Cipher cipher = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");
    cipher.init(Cipher.WRAP_MODE, peer);
    return cipher.wrap(session);
  }
}
`;

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>pay</groupId>
  <artifactId>payments-api</artifactId>
  <version>1.3.0</version>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.4</version>
  </parent>
  <properties><java.version>17</java.version></properties>
</project>
`;

const EXISTING_TEST = `package pay.security;

import org.junit.jupiter.api.Test;

class SettlementSignerTest {
  @Test
  void signsASettlement() { }
}
`;

export async function makeTestRepo(): Promise<TestRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'proteus-repo-'));

  const git = (...args: string[]) => run('git', ['-C', dir, ...args]);
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content, 'utf8');
  };

  await run('git', ['init', '--quiet', '--initial-branch=main', dir]);
  await git('config', 'user.name', 'Fixture Author');
  await git('config', 'user.email', 'fixture@example.test');
  await git('config', 'commit.gpgsign', 'false');

  await write('pom.xml', POM);
  await write('src/main/java/pay/security/CryptoService.java', SOURCE);
  await write('src/test/java/pay/security/SettlementSignerTest.java', EXISTING_TEST);
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'initial');

  const { stdout: sha } = await git('rev-parse', 'HEAD');

  return {
    dir,
    baseCommitSha: sha.trim(),
    defaultBranch: 'main',
    write,
    filesAt: async (ref) => {
      const { stdout } = await git('ls-tree', '-r', '--name-only', ref);
      return stdout.trim().split('\n').filter(Boolean).sort();
    },
    shaOf: async (ref) => (await git('rev-parse', ref)).stdout.trim(),
    branches: async () =>
      (await git('for-each-ref', '--format=%(refname:short)', 'refs/heads'))
        .stdout.trim().split('\n').filter(Boolean).sort(),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * XML-escapes as Surefire does.
 *
 * Not cosmetic: a JUnit failure message routinely contains `<` and `>` —
 * `expected: <256> but was: <1088>` is the canonical shape — and an unescaped
 * fixture produces XML the parser reads differently from the real thing. The
 * first version of this helper did not escape, and the round trip through
 * `unescapeXml` was never exercised.
 */
const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * Surefire's XML, as Maven writes it.
 *
 * Built rather than checked in so a test can state the outcome it needs in one
 * line, and so the parser is exercised against the real element shape —
 * self-closing passes, nested `<failure>` with an escaped message attribute and
 * a stack.
 */
export function surefireXml(
  suite: string,
  cases: Array<{ name: string; failure?: string; skipped?: boolean }>,
): string {
  const body = cases.map((c) => {
    if (c.failure) {
      return `  <testcase name="${c.name}" classname="${suite}" time="0.01">\n`
        + `    <failure message="${xmlEscape(c.failure)}" type="java.lang.AssertionError">`
        + `java.lang.AssertionError: ${xmlEscape(c.failure)}`
        + `\n\tat ${suite}.${c.name}(${suite.split('.').pop()}.java:42)`
        + `</failure>\n  </testcase>`;
    }
    if (c.skipped) {
      return `  <testcase name="${c.name}" classname="${suite}" time="0"><skipped/></testcase>`;
    }
    return `  <testcase name="${c.name}" classname="${suite}" time="0.01"/>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${suite}" tests="${cases.length}" failures="${cases.filter((c) => c.failure).length}" errors="0" skipped="${cases.filter((c) => c.skipped).length}">
${body}
</testsuite>`;
}

export const surefireReport = (suite: string, cases: Parameters<typeof surefireXml>[1]) => ({
  path: `target/surefire-reports/TEST-${suite}.xml`,
  xml: surefireXml(suite, cases),
});

export const failsafeReport = (suite: string, cases: Parameters<typeof surefireXml>[1]) => ({
  path: `target/failsafe-reports/TEST-${suite}.xml`,
  xml: surefireXml(suite, cases),
});
