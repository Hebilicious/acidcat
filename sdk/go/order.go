package acidcat

import (
	"bytes"
	"encoding/json"
	"slices"
)

// member is one member of an object that keeps the order members were added in.
type member struct {
	key   string
	value any
}

// object is a JSON object that keeps the order members were added in, so that a catalog renders in the order it
// was written. Plain Go maps render with sorted keys.
type object []member

func (o object) optional(key string, value any, present bool) object {
	if !present {
		return o
	}
	return append(o, member{key, value})
}

func (o object) MarshalJSON() ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for i, m := range o {
		if i > 0 {
			buffer.WriteByte(',')
		}
		key, err := marshal(m.key)
		if err != nil {
			return nil, err
		}
		value, err := marshal(m.value)
		if err != nil {
			return nil, err
		}
		buffer.Write(key)
		buffer.WriteByte(':')
		buffer.Write(value)
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

func marshal(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
