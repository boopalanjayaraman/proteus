import {
  AgentAction, Artifact, Assessment, Baseline, COLLECTIONS, DiscoveryRun,
  Evidence, ExecutionRun, Finding, GraphEdge, GraphNode, HumanGate,
  MigrationAttempt, MigrationChange, MigrationPolicy, MigrationRun, ProblemThread,
  ProjectFile, Recommendation, SandboxDeployment, User, VerificationResult,
} from '@proteus/schema';
import type { Db } from 'mongodb';
import type { z } from 'zod';
import { LeaseManager } from '../db/lease';
import { Repository } from './base';
import { EventRepository } from './events';
import { ProjectRepository } from './projects';

export * from './base';
export * from './events';
export * from './projects';

/**
 * Every collection, typed and validated. Constructed once and passed around, so
 * nothing in the application reaches for the driver directly — which is also
 * what keeps `agent/` unable to touch Mongo (folder structure §4).
 */
export class Repositories {
  readonly users;
  readonly projects: ProjectRepository;
  readonly projectFiles;
  readonly evidence;
  readonly discoveryRuns;
  readonly findings;
  readonly graphNodes;
  readonly graphEdges;
  readonly recommendations;
  readonly assessments;
  readonly migrationPolicies;
  readonly migrationRuns;
  readonly baselines;
  readonly migrationAttempts;
  readonly problemThreads;
  readonly migrationChanges;
  readonly executionRuns;
  readonly verificationResults;
  readonly sandboxDeployments;
  readonly humanGates;
  readonly events: EventRepository;
  readonly agentActions;
  readonly artifacts;

  /** Single-writer guards for the two long-running phases. */
  readonly migrationLease: LeaseManager;
  readonly discoveryLease: LeaseManager;

  constructor(private readonly database: Db) {
    const r = <S extends z.ZodTypeAny>(name: string, schema: S) =>
      new Repository<S>(database, name, schema);

    this.users = r(COLLECTIONS.users, User);
    this.projects = new ProjectRepository(database);
    this.projectFiles = r(COLLECTIONS.projectFiles, ProjectFile);
    this.evidence = r(COLLECTIONS.evidence, Evidence);
    this.discoveryRuns = r(COLLECTIONS.discoveryRuns, DiscoveryRun);
    this.findings = r(COLLECTIONS.findings, Finding);
    this.graphNodes = r(COLLECTIONS.graphNodes, GraphNode);
    this.graphEdges = r(COLLECTIONS.graphEdges, GraphEdge);
    this.recommendations = r(COLLECTIONS.recommendations, Recommendation);
    this.assessments = r(COLLECTIONS.assessments, Assessment);
    this.migrationPolicies = r(COLLECTIONS.migrationPolicies, MigrationPolicy);
    this.migrationRuns = r(COLLECTIONS.migrationRuns, MigrationRun);
    this.baselines = r(COLLECTIONS.baselines, Baseline);
    this.migrationAttempts = r(COLLECTIONS.migrationAttempts, MigrationAttempt);
    this.problemThreads = r(COLLECTIONS.problemThreads, ProblemThread);
    this.migrationChanges = r(COLLECTIONS.migrationChanges, MigrationChange);
    this.executionRuns = r(COLLECTIONS.executionRuns, ExecutionRun);
    this.verificationResults = r(COLLECTIONS.verificationResults, VerificationResult);
    this.sandboxDeployments = r(COLLECTIONS.sandboxDeployments, SandboxDeployment);
    this.humanGates = r(COLLECTIONS.humanGates, HumanGate);
    this.events = new EventRepository(database);
    this.agentActions = r(COLLECTIONS.agentActions, AgentAction);
    this.artifacts = r(COLLECTIONS.artifacts, Artifact);

    this.migrationLease = new LeaseManager(database, COLLECTIONS.migrationRuns, 'migrationRunId');
    this.discoveryLease = new LeaseManager(database, COLLECTIONS.discoveryRuns, 'discoveryRunId');
  }

  get db(): Db {
    return this.database;
  }
}
