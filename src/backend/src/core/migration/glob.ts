/**
 * Path-pattern matching for approved migration scope.
 *
 * ONE implementation, because there were two and they disagreed.
 *
 * The loop refuses a patch touching a path outside the plan; verification
 * independently re-checks the same thing for `MIGRATION_POLICY_SATISFIED`. Both
 * had their own copy of this function. When the zero-directory `**\/` case was
 * fixed in the loop's copy, verification's kept the old behaviour — so a run
 * passed the loop's scope check, migrated correctly, went green on every test,
 * and was then failed by verification for `3 file(s) changed outside the
 * approved scope`: the very files the plan had authorised.
 *
 * A rule enforced in two places is a rule that will eventually be enforced two
 * different ways.
 */
/**
 * A declared path pattern, as a matcher.
 *
 * `*` stops at a directory boundary and `**` crosses one, which is what a reader
 * of `src/main/java/pay/security/*.java` expects. Built by walking the glob
 * rather than by chained replaces, so a literal escaped in one pass cannot be
 * re-interpreted by the next.
 *
 * `**\/` matches ZERO or more directories, which is the whole point of the
 * form and the case this used to get wrong. `**` alone became `.*` and the
 * following slash stayed literal, so `**\/pom.xml` compiled to `^.*\/pom\.xml$`
 * — matching `a/pom.xml` but never `pom.xml`.
 *
 * A run was lost to it. The assessment declared `**\/pom.xml` for the dependency
 * upgrade, the agent edited the root `pom.xml`, and a change squarely inside the
 * approved scope was refused as a scope breach. That opened a blocking gate,
 * `NO_CRITICAL_BLOCKER` failed, and the migration was reported unverified — for
 * a patch that was correct. The same plan phrased as a bare `pom.xml` had
 * succeeded an hour earlier, which is what made it look environmental.
 */
export function toPattern(glob: string): RegExp {
  const SPECIAL = '.+^${}()|[]\\?';
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // The directory segment is optional, so `**/x` matches `x`.
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i++;
        }
      } else {
        out += '[^/]*';
      }
    } else if (SPECIAL.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}
