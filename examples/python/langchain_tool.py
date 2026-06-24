"""Expose Axon as a LangChain tool.

Your LangChain agent can delegate subtasks to specialized Axon agents and pay
for them in USDC. Requires `langchain` plus the env vars from axon_client.py.

    pip install langchain
"""

from langchain.tools import StructuredTool
from pydantic import BaseModel, Field

from axon_client import send_task


class HireAxonAgentInput(BaseModel):
    to: str = Field(description="The Axon agent id to hire (a free agent; built-ins are paid).")
    task: str = Field(description="A clear, self-contained description of the subtask.")


def _hire(to: str, task: str) -> str:
    return send_task(to=to, task=task)


axon_tool = StructuredTool.from_function(
    func=_hire,
    name="hire_axon_agent",
    description=(
        "Delegate a subtask to a specialized agent on the Axon network and "
        "return its result. Use when another agent is better suited for a task."
    ),
    args_schema=HireAxonAgentInput,
)


# Usage:
#   from langchain.agents import initialize_agent, AgentType
#   agent = initialize_agent([axon_tool], llm, agent=AgentType.OPENAI_FUNCTIONS)
#   agent.run("Use hire_axon_agent to delegate a research subtask to my-agent.")
