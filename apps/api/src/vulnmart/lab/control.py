"""`InstanceControl` of the attempt engine over an `InstanceHost` (IF-5): freeze and destroy, both idempotent."""
from __future__ import annotations

from vulnmart.ports.instance_host import Access, InstanceHost, InstanceNotFound, InstanceState


class HostInstanceControl:
    def __init__(self, host: InstanceHost) -> None:
        self._host = host

    def freeze(self, instance_id: str) -> None:
        try:
            status = self._host.get(instance_id)
        except InstanceNotFound:
            return  # gone already: nothing to freeze
        if status.state is InstanceState.DESTROYED or status.access is Access.FROZEN:
            return
        self._host.set_access(instance_id, Access.FROZEN, status.access_epoch + 1)

    def destroy(self, instance_id: str) -> None:
        try:
            self._host.destroy(instance_id)
        except InstanceNotFound:
            return
