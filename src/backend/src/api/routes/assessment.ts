import type { Finding, Recommendation } from '@proteus/schema';
import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../../core/repositories';
import type { AssessmentService } from '../../core/services/assessment';
import type { BlobStore } from '../../integrations/storage/blobs';
import { ApiError } from '../errors';
import { loadOwnedProject } from '../middleware/ownership';

interface Params { id: string }
interface ArtifactParams extends Params { artifactId: string }

export function registerAssessmentRoutes(
  app: FastifyInstance,
  repos: Repositories,
  assessments: AssessmentService,
  blobs: BlobStore,
  /**
   * Regenerates the assessment. Injected because it needs the model, and this
   * layer must not import `agent/`.
   */
  regenerate?: (projectId: string) => Promise<void>,
): void {
  /**
   * The assessment screen, in one call.
   *
   * Findings, recommendations and the plan are returned together because the
   * screen is meaningless with any one of them missing, and three round trips
   * would let a user see a plan whose findings had not arrived.
   */
  app.get<{ Params: Params; Querystring: { version?: string } }>(
    '/projects/:id/assessment',
    async (req) => {
      await loadOwnedProject(repos, req, req.params.id);

      const assessment = req.query.version
        ? await assessments.version(req.params.id, Number(req.query.version))
        : await assessments.current(req.params.id);
      if (!assessment) throw ApiError.notFound('No assessment has been generated yet.');

      const [findings, recommendations] = await Promise.all([
        repos.findings.collection
          .find({ findingId: { $in: assessment.snapshot.findingIds } } as never)
          .toArray() as unknown as Promise<Finding[]>,
        repos.recommendations.collection
          .find({ recommendationId: { $in: assessment.snapshot.recommendationIds } } as never)
          .toArray() as unknown as Promise<Recommendation[]>,
      ]);

      return {
        assessment,
        // Ordered by severity so the card a reviewer must not miss is first.
        findings: findings.sort((a, b) => severityRank(a) - severityRank(b)),
        recommendations,
        versions: (await assessments.history(req.params.id)).map((a) => ({
          version: a.version, status: a.status, generatedAt: a.generatedAt,
        })),
      };
    },
  );

  /** Regeneration produces version N+1; it never mutates what was on screen. */
  app.post<{ Params: Params }>('/projects/:id/assessment', async (req, reply) => {
    const project = await loadOwnedProject(repos, req, req.params.id);
    if (!regenerate) throw ApiError.badRequest('Assessment generation is not configured.');
    if (!project.summary.discoveryComplete) {
      throw ApiError.badRequest('Discovery has not completed for this project.');
    }
    await regenerate(req.params.id);
    return reply.status(202).send({ status: 'GENERATING' });
  });

  app.get<{ Params: Params }>('/projects/:id/recommendations', async (req) => {
    await loadOwnedProject(repos, req, req.params.id);
    const recommendations = await repos.recommendations.find({ projectId: req.params.id } as never);
    return { count: recommendations.length, recommendations };
  });

  app.get<{ Params: Params }>('/projects/:id/artifacts', async (req) => {
    await loadOwnedProject(repos, req, req.params.id);
    const artifacts = await repos.artifacts.find({ projectId: req.params.id } as never);
    // `contentSnapshot` is the whole report; the list view has no use for it.
    return {
      artifacts: artifacts.map(({ contentSnapshot: _snapshot, ...rest }) => rest),
    };
  });

  /** The download. Streams the stored bytes rather than re-rendering them. */
  app.get<{ Params: ArtifactParams }>('/projects/:id/artifacts/:artifactId', async (req, reply) => {
    await loadOwnedProject(repos, req, req.params.id);
    const artifact = await repos.artifacts.findOne({
      projectId: req.params.id, artifactId: req.params.artifactId,
    } as never);
    if (!artifact) throw ApiError.notFound('Artifact not found.');
    if (artifact.status !== 'READY') throw ApiError.badRequest('Artifact is not ready.');

    const path = artifact.gcsUri.replace(/^gs:\/\/[^/]+\//, '');
    const body = await blobs.get(path);
    const extension = artifact.format === 'MARKDOWN' ? 'md' : artifact.format.toLowerCase();

    return reply
      .header('content-type', CONTENT_TYPES[artifact.format])
      .header(
        'content-disposition',
        `attachment; filename="${artifact.title.replace(/[^\w.-]+/g, '-')}.${extension}"`,
      )
      .send(body);
  });
}

const CONTENT_TYPES: Record<string, string> = {
  MARKDOWN: 'text/markdown; charset=utf-8',
  JSON: 'application/json',
  PDF: 'application/pdf',
  DIFF: 'text/x-diff; charset=utf-8',
};

const ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const severityRank = (f: Finding): number => ORDER.indexOf(f.severity);
