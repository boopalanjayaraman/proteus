import type { RepositoryProfile } from '@proteus/schema';
import type { WorkingCopy } from './workingCopy';

/**
 * What kind of project this is.
 *
 * Renders as the `PUBLIC · JAVA 17 · MAVEN` chip and opens the discovery feed.
 * Read from the build manifest rather than guessed from file extensions,
 * because the manifest is the thing that is actually authoritative — and where
 * it is silent, the field is left absent rather than filled with a plausible
 * default.
 */
export async function detectProfile(wc: WorkingCopy): Promise<RepositoryProfile> {
  const files = await wc.files();
  const profile: RepositoryProfile = {
    language: 'Unknown',
    testFrameworks: [],
    fileCount: files.length,
    detectedAt: new Date(),
  };

  const pom = files.find((f) => f.path === 'pom.xml');
  if (pom) {
    const xml = await wc.read(pom.path);
    profile.language = 'Java';
    profile.buildSystem = 'Maven';
    profile.languageVersion = first(xml, /<java\.version>([^<]+)</) ??
      first(xml, /<maven\.compiler\.release>([^<]+)</);

    const springVersion = first(xml, /spring-boot-starter-parent<\/artifactId>\s*<version>([^<]+)</);
    if (springVersion) profile.framework = `Spring Boot ${springVersion.split('.').slice(0, 2).join('.')}`;

    // Surefire and failsafe are usually implicit in a Spring Boot parent; the
    // split between unit and integration tests matters for the baseline, so
    // report what the tree shows rather than what the pom happens to declare.
    if (files.some((f) => /Test\.java$/.test(f.path))) profile.testFrameworks.push('surefire');
    if (files.some((f) => /IntegrationTest\.java$/.test(f.path))) profile.testFrameworks.push('failsafe');
    return profile;
  }

  const gradle = files.find((f) => f.path === 'build.gradle' || f.path === 'build.gradle.kts');
  if (gradle) {
    profile.language = 'Java';
    profile.buildSystem = 'Gradle';
    return profile;
  }

  if (files.some((f) => f.path === 'package.json')) {
    profile.language = 'TypeScript/JavaScript';
    profile.buildSystem = 'npm';
  }
  return profile;
}

const first = (text: string, re: RegExp): string | undefined => re.exec(text)?.[1]?.trim();
