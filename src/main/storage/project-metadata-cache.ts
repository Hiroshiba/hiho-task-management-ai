import { gidSchema } from "../../shared/domain";
import {
  projectMetadataCacheSchema,
  type ProjectMetadataCache,
} from "../../shared/storage";
import { parseStorageJson, serializeStorageJson } from "./json";
import type { SqliteDatabase } from "./types";

interface ProjectMetadataCacheRow {
  readonly project_gid: string;
  readonly project_json: string;
  readonly sections_json: string;
  readonly tags_json: string;
  readonly cached_at: string;
}

function rowToProjectMetadataCache(row: ProjectMetadataCacheRow): ProjectMetadataCache {
  return projectMetadataCacheSchema.parse({
    project: parseStorageJson(row.project_json, projectMetadataCacheSchema.shape.project),
    sections: parseStorageJson(row.sections_json, projectMetadataCacheSchema.shape.sections),
    tags: parseStorageJson(row.tags_json, projectMetadataCacheSchema.shape.tags),
    cached_at: row.cached_at,
  });
}

/** プロジェクトメタデータキャッシュのSQLite操作を提供します。 */
export class ProjectMetadataCacheStore {
  private readonly saveStatement;
  private readonly selectAllStatement;
  private readonly selectOneStatement;

  public constructor(private readonly database: SqliteDatabase) {
    this.saveStatement = database.prepare<
      [string, string, string, string, string],
      unknown
    >(
      `INSERT INTO project_metadata_cache (project_gid, project_json, sections_json, tags_json, cached_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_gid) DO UPDATE SET
         project_json = excluded.project_json,
         sections_json = excluded.sections_json,
         tags_json = excluded.tags_json,
         cached_at = excluded.cached_at`,
    );
    this.selectAllStatement = database.prepare<[], ProjectMetadataCacheRow>(
      "SELECT project_gid, project_json, sections_json, tags_json, cached_at FROM project_metadata_cache ORDER BY project_gid",
    );
    this.selectOneStatement = database.prepare<[string], ProjectMetadataCacheRow>(
      "SELECT project_gid, project_json, sections_json, tags_json, cached_at FROM project_metadata_cache WHERE project_gid = ?",
    );
  }

  /** プロジェクトメタデータキャッシュを保存します。 */
  public save(cache: ProjectMetadataCache): void {
    const validatedCache = projectMetadataCacheSchema.parse(cache);
    this.saveStatement.run(
      validatedCache.project.gid,
      serializeStorageJson(validatedCache.project),
      serializeStorageJson(validatedCache.sections),
      serializeStorageJson(validatedCache.tags),
      validatedCache.cached_at,
    );
  }

  /** GIDでプロジェクトメタデータキャッシュを読み出します。 */
  public get(projectGid: string): ProjectMetadataCache | undefined {
    const validatedProjectGid = gidSchema.parse(projectGid);
    const row = this.selectOneStatement.get(validatedProjectGid);
    if (row == null) {
      return undefined;
    }
    if (row.project_gid !== validatedProjectGid) {
      throw new Error("プロジェクトメタデータキャッシュのGIDが一致しません。");
    }
    return rowToProjectMetadataCache(row);
  }

  /** プロジェクトメタデータキャッシュを全件読み出します。 */
  public getAll(): readonly ProjectMetadataCache[] {
    return this.selectAllStatement.all().map((row) => {
      const cache = rowToProjectMetadataCache(row);
      if (cache.project.gid !== row.project_gid) {
        throw new Error("プロジェクトメタデータキャッシュのGIDが一致しません。");
      }
      return cache;
    });
  }
}
