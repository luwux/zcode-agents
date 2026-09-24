## ADDED Requirements

### Requirement: Mid-turn model and effort changes

The Host SHALL accept `switchModelConfig` for an ACP session while a turn is running and forward it to
the agent immediately. If the agent refuses the change while running, the Host SHALL apply it when the
turn settles and SHALL NOT drop it.

#### Scenario: Raise effort while Claude works

- **WHEN** a Claude Code turn is running and the user selects thought level `high` and sends a message
- **THEN** the Host calls `session/set_config_option` for effort before delivering the message, and the
  session config shows `high`

### Requirement: Steering running ACP turns

When the agent advertises steering, input sent while a turn runs SHALL be delivered into that turn and
shown as a `userInput` row of that turn. Agents without steering SHALL keep rejecting input while running.

#### Scenario: Steer settles race

- **WHEN** the agent answers the steer with `promptRequired` because the turn just ended
- **THEN** the Host starts the input as the next turn after the current turn settles, exactly once
