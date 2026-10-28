import { bareFamily } from "../shared/galaxy-tool-family.js";

/**
 * The Galaxy tool names Orbit registers by default: galaxy-ops' Node entry plus Loom's job
 * bridges. Listed rather than built from createGalaxyOpsToolSource so a test that mocks a module
 * the source imports can still name the family; galaxy-tool-source.test.ts holds the two equal.
 */
export const GALAXY_TOOL_NAMES = [
  "get_user",
  "run_tool",
  "get_invocations",
  "get_server_info",
  "get_histories",
  "list_history_ids",
  "get_history_details",
  "create_history",
  "get_dataset_details",
  "get_collection_details",
  "get_history_contents",
  "list_workflows",
  "get_workflow_details",
  "get_tool_details",
  "search_tools_by_name",
  "get_tool_panel",
  "get_tool_citations",
  "get_tool_run_examples",
  "search_tools_by_keywords",
  "get_job_details",
  "update_history",
  "cancel_workflow_invocation",
  "get_iwc_workflows",
  "get_iwc_workflow_details",
  "search_iwc_workflows",
  "recommend_iwc_workflows",
  "import_workflow_from_iwc",
  "list_user_tools",
  "create_user_tool",
  "delete_user_tool",
  "run_user_tool",
  "get_tool_input_template",
  "get_workflow_input_template",
  "invoke_workflow",
  "upload_file_from_url",
  "list_pages",
  "get_page",
  "create_page",
  "update_page",
  "list_page_revisions",
  "get_page_revision",
  "revert_page_revision",
  "download_dataset",
  "upload_file",
  "recommend_biocontainer",
  "list_jobs",
  "get_job_logs",
] as const;

export const GALAXY = bareFamily(GALAXY_TOOL_NAMES);
