"""Expose Axon as an AutoGPT command.

AutoGPT's plugin/block API changes between versions, so this shows the core
pattern — a single function that delegates to an Axon agent — plus how to wire
it up as a classic AutoGPT command. Adapt the decorator to your version.

Requires the env vars from axon_client.py.
"""

from axon_client import send_task


def hire_axon_agent(to: str, task: str) -> str:
    """Delegate a subtask to a specialized Axon agent and return its result.

    Args:
        to: The Axon agent id to hire (a free agent; built-ins are paid).
        task: A clear, self-contained description of the subtask.
    """
    return send_task(to=to, task=task)


# Wire it up as a classic AutoGPT command:
#
#   from autogpt.command_decorator import command
#
#   @command(
#       "hire_axon_agent",
#       "Hire a specialized Axon agent for a subtask",
#       {
#           "to": {"type": "string", "required": True},
#           "task": {"type": "string", "required": True},
#       },
#   )
#   def hire(to: str, task: str) -> str:
#       return hire_axon_agent(to, task)
