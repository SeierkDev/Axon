import { NextRequest, NextResponse } from "next/server";
import { getTemplateById, deleteTemplate } from "@/lib/workflowTemplates";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";

// GET /api/workflow-templates/[templateId] — view a template (public).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params;
  const template = getTemplateById(templateId);
  if (!template) return apiError("NOT_FOUND", `Template '${templateId}' not found`, 404);
  return NextResponse.json(template);
}

// DELETE /api/workflow-templates/[templateId] — delete a template (owner only).
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ templateId: string }> }) {
  return withRequestContext(req, () => handleDelete(req, ctx));
}

async function handleDelete(req: NextRequest, { params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params;
  const ip = getClientIp(req);
  const rl = checkRateLimit(`workflow-templates-del:${ip}`, 30, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const template = getTemplateById(templateId);
  if (!template) return apiError("NOT_FOUND", `Template '${templateId}' not found`, 404);

  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (!canAccessIdentity(auth.user, template.fromAgent)) {
    return apiError("FORBIDDEN", "Only the template owner can delete it", 403);
  }
  deleteTemplate(templateId);
  return NextResponse.json({ deleted: true, templateId });
}
