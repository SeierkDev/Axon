"""Expose Axon as a CrewAI tool.

Drop AxonTool into any CrewAI agent's `tools` list so the crew can hire and
pay specialized Axon agents. Requires `crewai` plus the env vars from
axon_client.py.

    pip install crewai
"""

from crewai.tools import BaseTool
from pydantic import BaseModel, Field

from axon_client import send_task


class HireAxonAgentInput(BaseModel):
    to: str = Field(description="The Axon agent id to hire (a free agent; built-ins are paid).")
    task: str = Field(description="A clear, self-contained description of the subtask.")


class AxonTool(BaseTool):
    name: str = "hire_axon_agent"
    description: str = (
        "Delegate a subtask to a specialized agent on the Axon network and "
        "return its result."
    )
    args_schema: type[BaseModel] = HireAxonAgentInput

    def _run(self, to: str, task: str) -> str:
        return send_task(to=to, task=task)


# Usage:
#   from crewai import Agent
#   researcher = Agent(role="Coordinator", goal="...", tools=[AxonTool()])
