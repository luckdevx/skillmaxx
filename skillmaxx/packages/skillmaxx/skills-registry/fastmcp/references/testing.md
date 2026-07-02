# FastMCP Testing Reference

Comprehensive testing guide for FastMCP servers and tools.

## Two Testing Levels

| Level | What it tests | Speed | When to use |
|---|---|---|---|
| Direct function call | Tool logic, return shapes, error handling | Fastest | Unit tests for every tool |
| `fastmcp.Client` | Full MCP protocol layer + registration | Fast (in-process) | Integration tests, schema validation |

---

## Level 1: Direct Function Call

Call tool functions directly with `ctx=None`. No server, no port, no subprocess needed.

### Basic test structure

```python
import pytest
from my_server.tools import get_records, resource_tool

@pytest.mark.asyncio
async def test_search_returns_results():
    result = await get_records(query="widget", limit=5, ctx=None)
    assert result["status"] == "success"
    assert "output" in result
    assert "data" in result
    assert result["count"] >= 0

@pytest.mark.asyncio
async def test_search_empty_results():
    result = await get_records(query="xzxzxzxz_not_found", ctx=None)
    assert result["status"] == "success"
    assert result["count"] == 0
    assert "No" in result["output"]  # human-friendly empty message, not an exception

@pytest.mark.asyncio
async def test_search_missing_required_param():
    # operation='list_values' requires column
    result = await resource_tool(operation="list_values", ctx=None)
    assert result["status"] == "error"
    assert "column" in result["error"].lower()
    assert "Valid:" in result["error"] or "schema" in result["error"]  # guides the caller
```

### Testing multi-operation tools

```python
@pytest.mark.asyncio
async def test_multi_op_unknown_operation():
    result = await resource_tool(operation="nonexistent", ctx=None)
    assert result["status"] == "error"
    assert "Valid:" in result["error"]

@pytest.mark.asyncio
async def test_multi_op_list_values():
    result = await resource_tool(operation="list_values", column="STATUS", ctx=None)
    assert result["status"] == "success"
    assert isinstance(result["values"], list)
    assert len(result["values"]) > 0

@pytest.mark.asyncio
async def test_multi_op_search_after_list_values():
    # Simulate the agent workflow: list_values first, then search
    lv_result = await resource_tool(operation="list_values", column="STATUS", ctx=None)
    first_category = lv_result["values"][0]

    search_result = await resource_tool(
        operation="search", query="item", category=first_category, ctx=None
    )
    assert search_result["status"] in ("success", "partial")
```

### Testing partial failures

```python
from unittest.mock import AsyncMock, patch

@pytest.mark.asyncio
async def test_partial_failure_continues():
    """When enrichment fails, base data should still return."""
    with patch("my_server.tools.fetch_secondary_data", side_effect=Exception("timeout")):
        result = await aggregate_items(record_ids=["rec1", "rec2"], ctx=None)
    assert result["status"] == "partial"
    assert len(result["data"]) > 0         # base data still returned
    assert len(result["errors"]) > 0       # errors reported
    assert "timeout" in result["output"]   # surfaced in the output field

@pytest.mark.asyncio
async def test_hard_failure_skips_item():
    """When base data fails, the entire item is skipped."""
    with patch("my_server.tools.fetch_primary_data", side_effect=Exception("not found")):
        result = await aggregate_items(record_ids=["rec1"], ctx=None)
    assert result["count"] == 0
    assert len(result["errors"]) == 1
```

### Testing context is truly optional

```python
@pytest.mark.asyncio
async def test_tool_works_without_context():
    # Must not raise AttributeError accessing ctx fields
    result = await get_records(query="test", ctx=None)
    assert result["status"] in ("success", "error")  # no AttributeError

@pytest.mark.asyncio
async def test_tool_works_without_context_all_tools():
    tools = [get_records, lookup_schema, get_schema]
    for tool_fn in tools:
        try:
            await tool_fn(ctx=None)  # may fail for other reasons, but not AttributeError on ctx
        except TypeError:
            pass  # tool requires other params — that's fine, we're testing ctx safety
```

---

## Level 2: In-Process Client

`fastmcp.Client` creates a full MCP connection in-process — no HTTP, no port. Tests that:
- Tools are actually registered and discoverable
- Tool schemas match what the LLM would receive
- Return shapes survive the MCP protocol serialization layer

```python
from fastmcp import Client
import pytest

@pytest.mark.asyncio
async def test_tools_are_registered():
    async with Client(mcp) as client:
        tools = await client.list_tools()
        tool_names = [t.name for t in tools]
        assert "get_records" in tool_names
        assert "resource_tool" in tool_names

@pytest.mark.asyncio
async def test_tool_schema_has_required_params():
    async with Client(mcp) as client:
        tools = await client.list_tools()
        search_tool = next(t for t in tools if t.name == "get_records")
        props = search_tool.inputSchema.get("properties", {})
        assert "query" in props                  # required param exists in schema
        assert "ctx" not in props                # ctx not exposed to LLM

@pytest.mark.asyncio
async def test_tool_call_via_protocol():
    async with Client(mcp) as client:
        result = await client.call_tool("get_records", {"query": "widget"})
        assert result.is_error is False
        assert result.data["status"] == "success"
        assert "output" in result.data
```

### Testing lifespan with Client

```python
@pytest.mark.asyncio
async def test_lifespan_initializes_state():
    """Verify startup/shutdown runs correctly and tools can access state."""
    async with Client(mcp) as client:
        # If lifespan failed, tool call will fail with AttributeError on state
        result = await client.call_tool("get_records", {"query": "test"})
        assert result.is_error is False  # lifespan succeeded
```

### Testing error tool calls

```python
@pytest.mark.asyncio
async def test_tool_error_is_clean():
    async with Client(mcp) as client:
        result = await client.call_tool("resource_tool", {"operation": "bad_op"})
        # FastMCP wraps tool errors — check the returned data shape
        assert result.data["status"] == "error"
        assert "Valid:" in result.data["error"]
```

---

## Testing Checklist

Run this checklist for every tool before publishing:

- [ ] Happy path with valid params → `status: success`, `output` present, no exception
- [ ] Missing required param → `status: error`, message names the missing param
- [ ] Invalid param value → `status: error`, message names valid alternatives
- [ ] Empty results → `status: success`, clean empty message (not exception)
- [ ] `ctx=None` call → no `AttributeError` (context is truly optional)
- [ ] Partial failure (mock one external call to fail) → partial results returned, not total failure
- [ ] Client test: tool appears in `list_tools()`
- [ ] Client test: `ctx` not in tool's `inputSchema.properties`
- [ ] Client test: successful call returns `.data["output"]`

---

## pytest Configuration

```toml
# pyproject.toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

```python
# conftest.py
import pytest
from my_server import mcp

@pytest.fixture
def server():
    return mcp

@pytest.fixture
async def client(server):
    async with Client(server) as c:
        yield c
```
