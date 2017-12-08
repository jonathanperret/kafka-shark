import React, {Component} from 'react';
import blessed from 'blessed';
import {render} from 'react-blessed';
const util = require('util');

/**
 * Stylesheet
 */
const stylesheet = {
  bordered: {
    border: {
      type: 'line'
    },
    style: {
      border: {
        fg: 'blue'
      }
    }
  }
};

let log = null, requestBox = null, responseBox = null;

/**
 * Top level component.
 */
class Dashboard extends Component {
  render() {
    return (
      <element>
        <Log ref={(l)=>log=l} height="20%" />
        <Packet title="Request" top="20%" height="30%" ref={(c)=>requestBox=c} />
        <Packet title="Response" top="50%" height="50%" ref={(c)=>responseBox=c} />
      </element>
    );
  }
}

function pad(n) {
  return ('         ' + n).slice(-8);
}

/**
 * Log component.
 */
class Log extends Component {
  constructor(props) {
    super(props);

    this.state = {requests: []};
    this.pending = {};
  }

  clear() {
    this.pending = {};
    this.refs.list.clearItems();
    this.setState({requests: []});
    this.refreshSelected();
  }

  addPacket(packet) {
    if (packet.request_key) {
      this.pending[packet.frame] = this.addRequest({requestPacket: packet});
    } else {
      let requestIndex = this.pending[packet.request_frame];
      if (requestIndex === undefined) {
        this.addRequest({responsePacket: packet});
      } else {
        delete this.pending[packet.request_frame];
        const request = this.state.requests[requestIndex];
        request.responsePacket = packet;
        this.requestUpdated(requestIndex);
      }
    }
  }

  addRequest(request) {
    this.state.requests.push(request);
    const requestIndex = this.state.requests.length - 1;

    this.setState({});
    this.refs.list.pushItem(this.renderTitle(request));

    if(this.refs.list.selected === this.state.requests.length - 2) {
      this.refs.list.select(requestIndex);
    }

    return requestIndex;
  }

  requestUpdated(index) {
    this.refs.list.setItem(index, this.renderTitle(this.state.requests[index]));
    if (index == this.refs.list.selected) {
      this.refreshSelected();
    }
  }

  renderTitle(request) {
    return pad(request.requestPacket ? request.requestPacket.frame : '*') + ' ' +
           pad(request.responsePacket ? request.responsePacket.frame : '*') + ' ' +
           (request.requestPacket ? request.requestPacket.frameTime : '*') + ' ' +
           (request.requestPacket ? request.requestPacket.showname : '*');
  }

  refreshSelected() {
    const request = this.state.requests[this.refs.list.selected];
    requestBox.setPacket(request && request.requestPacket);
    responseBox.setPacket(request && request.responsePacket);
  }

  render() {
    return (
      <list ref="list"
           label={`Log (${this.state.requests.length})`}
           class={stylesheet.bordered}
           width="100%"
           height={this.props.height}
           mouse={true}
           keys={true}
           vi={true}
           onSelectItem={()=>{this.refreshSelected()}}
           style={{
             item: { fg: 'white' },
             selected: { fg: 'black', bg: 'white' },
           }}
         />
    );
  }
}

class Packet extends Component {
  constructor(props) {
    super(props);

    this.state = {packet: null};
  }

  setPacket(packet) {
    this.setState({packet: packet});
  }

  renderPacket(packet) {
    if (!packet) return '';

    if (packet.$) {
      //const raw = JSON.parse(JSON.stringify(packet));
      transform(packet);
      //packet.raw = raw;
    }

    return util.inspect(packet, { colors: true, depth: null, breakLength: 120 });
  }

  render() {
    return (
      <box label={this.props.title}
           class={stylesheet.bordered}
           top={this.props.top}
           height={this.props.height}
           mouse={true}
           keys={true}
           vi={true}
           input={true}
           scrollable={true}>
        {this.renderPacket(this.state.packet)}
      </box>
    );
  }
}


/**
 * Rendering the screen.
 */
const screen = blessed.screen({
  autoPadding: true,
  smartCSR: true,
  title: 'kafka-shark dashboard'
});

screen.key(['escape', 'q', 'C-c'], function(ch, key) {
  return process.exit(0);
});

screen.key(['r'], function(ch, key) {
  log.clear();
});

const { spawn } = require('child_process');

const default_tshark_opts = [ '-o', 'kafka.tcp.ports:9092' ];

const tshark_args = [ '-l', '-T', 'pdml',
  ...( process.argv.length > 3 ? process.argv.slice(3) : default_tshark_opts ) ];

console.log('tshark', ...tshark_args);

const tshark = spawn('tshark', tshark_args);//'-Y', 'kafka.len']);

tshark.stdout.setEncoding('utf-8');

const Parser = require('xml-streamer');

var xmlReader = new Parser({
  resourcePath: '/pdml/packet',
  explicitArray: true
});

function fixname(name) {
  return name.replace(/^kafka\./, '').replace(/\./g, '_');
}

function transform(xmlObj) {
  const attrs = xmlObj.$;
  if(attrs) {
    delete xmlObj.$;
    Object.keys(attrs).forEach((attr) => {
      xmlObj[attr] = attrs[attr];
    });
  }
  delete xmlObj.name;
  delete xmlObj.pos;
  delete xmlObj.size;
  delete xmlObj.value;
  let fields = xmlObj.field || [];
  if (xmlObj.proto) {
    const protoFields = [].concat.apply([], xmlObj.proto.map((p)=>p.field));
    fields = protoFields.concat(fields);
    delete xmlObj.proto;
  }
  delete xmlObj.field;
  fields.forEach((field) => {
    if (field.$) {
      if (field.$.hide === 'yes') return;
      const showname = field.$.showname;
      if (showname && showname.match(/^([^:]+):\s*(.*)$/)) {
        let name = RegExp.$1;
        let value = RegExp.$2;
        if (field.$.name) {
          name = fixname(field.$.name);
        }
        if (value.match(/^[0-9]+$/)) {
          value = parseInt(value, 10);
        }
        xmlObj[name] = value;
      } else {
        let name = field.$.name;
        if (name) {
          name = fixname(name);
        } else if (field.$.show) {
          name = field.$.show + '_' + field.$.pos;
          delete field.$.show;
        } else {
          name = '_' + field.$.pos;
        }
        xmlObj[name] = transform(field);
      }
    }
  });
  return xmlObj;
}

function findField(proto, fieldName, cb) {
  const field = proto.field.find((f)=>f.$.name === fieldName);
  if (field) {
    return cb(field);
  }
  if (proto.proto) {
    return findField(proto.proto[0], fieldName, cb);
  }
}

xmlReader.on('data', function (item) {
  try {
    const packet = item;
    const geninfoProto = packet.proto.find((p)=>p.$.name === 'geninfo');
    const frameNum = parseInt(geninfoProto.field.find((f)=>f.$.name === 'num').$.show, 10);
    const frameTime = geninfoProto.field.find((f)=>f.$.name === 'timestamp').$.show;
    const kafkaProto = packet.proto.find((p)=>p.$.name === 'kafka');
    if (!kafkaProto) return;
    kafkaProto.frame = frameNum;
    kafkaProto.frameTime = frameTime;
    kafkaProto.showname = kafkaProto.$.showname;
    findField(kafkaProto, 'kafka.request_key', (f)=>{
      kafkaProto.request_key = f.$.show;
    });
    findField(kafkaProto, 'kafka.request_frame', (f)=>{
      kafkaProto.request_frame = parseInt(f.$.show, 10);
    });

    log.addPacket(kafkaProto);
  } catch(e) {
    screen.destroy();
    console.error(e);
    process.exit(1);
  }
});

xmlReader.on('error', function (error) {
  console.error(error);
  detail.setText(util.inspect(error));
})

//xmlReader.write('<pdml><packet>coucou</packet></pdml>');

tshark.stdout.pipe(xmlReader);

render(<Dashboard />, screen);
