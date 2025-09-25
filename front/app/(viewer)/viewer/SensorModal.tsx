"use client";

import { useEffect, useRef, useState } from "react";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  useDisclosure,
  useDraggable,
} from "@heroui/react";
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend
} from "chart.js";
import { Line } from 'react-chartjs-2';

import type { Sensor, SensorDatedValue, Channel } from "@/types/sensor";

type SensorModalProps = {
    sensor: Sensor | null,
    values: Map<string, SensorDatedValue> | null,
}

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

export function SensorModal(props: SensorModalProps) {
    const { sensor, values } = props;

    const { isOpen, onOpen, onClose } = useDisclosure();
    const modalRef = useRef(null);
    const {moveProps} = useDraggable({targetRef: modalRef, canOverflow: true, isDisabled: !isOpen});
    const [chartData, setChartData] = useState({});

    useEffect(() => {
        if (sensor && values) {
            const labels = Array.from(values.values()).map(v => new Date(v.timestamp).toLocaleTimeString());
            const data = {
                labels,
                datasets: [
                    {
                        label: sensor.name,
                        data: Array.from(values.values()).map(v => v.temperature),
                        borderColor: 'rgb(75, 192, 192)',
                        backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    }
                ]
            };
            setChartData(data);
            onOpen();
        }
    }, [sensor, values]);

    return (
        <Modal
            ref={modalRef}
            isOpen={isOpen}
            onClose={onClose}
            isDismissable={false}
            isKeyboardDismissDisabled={false}
            backdrop="transparent"
            size="3xl"
        >
            <ModalContent>{(onClose) => (
                <>
                    <ModalHeader {...moveProps} className="flex flex-col gap-1">{sensor.name}</ModalHeader>
                    <ModalBody className="flex flex-col gap-2">
                        <Line data={chartData} />
                    </ModalBody>
                </>
            )}</ModalContent>
        </Modal>
    )
}