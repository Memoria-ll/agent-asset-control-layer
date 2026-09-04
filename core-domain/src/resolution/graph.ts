  /** Kosaraju with explicit stacks; valid snapshots have no depth limit. */
export const stronglyConnectedComponents = <Node>(
    nodes: readonly Node[],
    outgoing: ReadonlyMap<Node, readonly Node[]>,
    compare: (left: Node, right: Node) => number,
  ): Node[][] => {
    const ordered = nodes.slice().sort(compare);
    const reverse = new Map<Node, Node[]>();
    for (const node of ordered) reverse.set(node, []);
    for (const node of ordered) {
      for (const target of outgoing.get(node) ?? []) {
        const incoming = reverse.get(target) ?? [];
        incoming.push(node);
        reverse.set(target, incoming);
      }
    }

    const visited = new Set<Node>();
    const finish: Node[] = [];
    for (const start of ordered) {
      if (visited.has(start)) continue;
      const stack: { readonly node: Node; nextIndex: number }[] = [{ node: start, nextIndex: 0 }];
      visited.add(start);
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        const neighbors = (outgoing.get(frame.node) ?? []).slice().sort(compare);
        if (frame.nextIndex < neighbors.length) {
          const target = neighbors[frame.nextIndex]!;
          frame.nextIndex += 1;
          if (visited.has(target)) continue;
          visited.add(target);
          stack.push({ node: target, nextIndex: 0 });
        } else {
          stack.pop();
          finish.push(frame.node);
        }
      }
    }

    const assigned = new Set<Node>();
    const components: Node[][] = [];
    for (const start of finish.slice().reverse()) {
      if (assigned.has(start)) continue;
      const component: Node[] = [];
      const stack: Node[] = [start];
      assigned.add(start);
      while (stack.length > 0) {
        const node = stack.pop()!;
        component.push(node);
        const neighbors = (reverse.get(node) ?? []).slice().sort(compare);
        for (const target of neighbors) {
          if (assigned.has(target)) continue;
          assigned.add(target);
          stack.push(target);
        }
      }
      component.sort(compare);
      components.push(component);
    }
    return components;
  };
